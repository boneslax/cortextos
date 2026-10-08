#!/bin/bash
# deploy-verify-watchdog.sh — POST-DEPLOY RUN-VERSION VERIFICATION (cortex gap, 2026-10-08).
#
# The gap (found live): trigger-watchdog.sh pages on a STALL (0 executing + backlog + nothing
# completed), but a deploy is invisible to it — a deploy that lands while a task's next run still
# executes the OLD version produces zero failures, zero missed schedules, and a silent wrong-version
# hour (mtz-wcr-scheduling-check ran v20261005.2 for 30+ min after v20261008.1 promoted). A deploy
# that never took effect looks exactly like a quiet tick.
#
# This script closes it, in the SAME shape as trigger-watchdog.sh: pure shell, no LLM, cron-driven,
# same read-key keycache + 3-tier Telegram alert path + fixture-test injection. Per watched project:
#
#   1. Latest DEPLOYED version via GET /api/v1/deployments (version + deployedAt).
#   2. If it equals the last-verified version in state → exit quiet (fast path, most ticks).
#   3. NEW version: fetch the latest runs (pageSize 100, has taskIdentifier + version), group by
#      task, and for every task seen in the window classify its FIRST post-deploy run:
#        run.version == new version  → verified
#        run.version != new version  → STALE (the deployed code is NOT what scheduled tasks run)
#      Tasks with NO post-deploy run yet stay PENDING — daily tasks may take a day; never alerts.
#   4. Alert (once per version transition, state-file dedup) only when at least one task went
#      STALE, or when every task seen since the PREVIOUS version is still PENDING past the
#      verification window — the "deployed nothing" case. A mix of verified + pending is normal.
#
# Tunables (env):
#   DEPLOYVERIFY_DRY_RUN   "1" => classify + log + print DECISION, skip send + state writes
#   VERIFY_WINDOW_MIN      minutes after deploy before PENDING-all tasks counts as "deployed
#                          nothing ran" (default 120)
#   WATCHDOG_RUNS_FIXTURE_<LABEL> / WATCHDOG_DEPLOY_FIXTURE_<label>   fixture files (tests)
#   TELEGRAM_API_BASE / WATCHDOG_CHAT_ID / OP_SA_TOKEN_FILE / CTX_*   same as trigger-watchdog
#
# Projects: same tuple list as trigger-watchdog.sh. Exit 0 always (cron-friendly). Errors logged.

set -uo pipefail

DRY_RUN="${DEPLOYVERIFY_DRY_RUN:-0}"
VERIFY_WINDOW_MIN="${VERIFY_WINDOW_MIN:-120}"
VERIFY_WINDOW_SEC=$((VERIFY_WINDOW_MIN * 60))

CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"
CTX_ORG="${CTX_ORG:-vault}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-solo}"
OP_SA_TOKEN_FILE="${OP_SA_TOKEN_FILE:-$HOME/.config/opbot/sa-token}"
OP_ITEM="chagb6unxtfqljbcrxu4pxmqxe"   # 1Password 'Trigger.dev' (PKM Automation) — same item the stall watchdog uses

PROJECTS=(
  "hubapp:proj_luyejwcyhjfojxxgwlit:hubapp_prod_read_key"
  "helpdesk:proj_dmalyhsdqqxehlagufef:helpdesk_prod_read_key"
)

STATE_DIR="$CTX_ROOT/state/trigger-watchdog"   # shared with the stall watchdog (one keycache)
LOG="$STATE_DIR/deploy-verify.log"
KEYCACHE_DIR="$STATE_DIR/keycache"
mkdir -p "$STATE_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }
file_mtime() { stat -f "%m" "$1" 2>/dev/null || stat -c "%Y" "$1" 2>/dev/null; }

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CURL="${CURL_BIN:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"
JQ="${JQ_BIN:-$(command -v jq 2>/dev/null || echo /usr/bin/jq)}"
OP="${OP_BIN:-$(command -v op 2>/dev/null || echo /usr/bin/op)}"
if ! command -v "$JQ" >/dev/null 2>&1 || ! command -v "$CURL" >/dev/null 2>&1; then
  log "FATAL: jq or curl not found (jq=$JQ curl=$CURL)"; exit 0
fi

AGENT_ENV="$CTX_AGENT_DIR/.env"
env_get() { [ -f "$AGENT_ENV" ] && sed -n "s/^$1=//p" "$AGENT_ENV" | head -1 | tr -d '"'; }
CHAT_ID="${WATCHDOG_CHAT_ID:-$(env_get CHAT_ID)}"
THREAD_ID="${WATCHDOG_THREAD_ID:-$(env_get TOPIC_ID)}"
BOT_TOKEN_FALLBACK="$(env_get BOT_TOKEN)"

# get_key — same contract as trigger-watchdog.sh: fresh-cache reuse (no op call), op on miss,
# last-good fallback on op failure. The cache files are SHARED with the stall watchdog, so the
# two scripts mutually refresh the same keys and neither pages the other into blindness.
get_key() {
  local field="$1"
  local cache="$KEYCACHE_DIR/$field.key" cached="" age=99999999 mt now
  if [ -f "$cache" ]; then
    cached="$(cat "$cache" 2>/dev/null)"
    mt="$(file_mtime "$cache" || echo 0)"; now="$(date -u +%s)"; age=$(( now - mt ))
  fi
  if [ -n "$cached" ] && [ "$age" -lt "${WATCHDOG_KEY_TTL:-3600}" ]; then echo "$cached"; return; fi
  local fresh="" rc=1
  if [ -f "$OP_SA_TOKEN_FILE" ]; then
    fresh="$(OP_SERVICE_ACCOUNT_TOKEN="$(cat "$OP_SA_TOKEN_FILE")" "$OP" --vault="PKM Automation" \
      item get "$OP_ITEM" --fields "$field" --reveal 2>/dev/null)"; rc=$?
  fi
  [ "$rc" -ne 0 ] && fresh=""
  if [ -n "$fresh" ]; then
    local t; t="$(mktemp "$KEYCACHE_DIR/.k-XXXXXX" 2>/dev/null)" \
      && printf '%s' "$fresh" > "$t" && chmod 600 "$t" && mv -f "$t" "$cache"
    echo "$fresh"; return
  fi
  [ -n "$cached" ] && { log "[keycache] op fetch failed for $field — last-good cached key"; echo "$cached"; return; }
  log "[keycache] op fetch failed for $field + no cache"
  echo ""
}

# send_alert — same 2-tier shape (bus CLI, raw curl); the stall watchdog owns the DNS-bypass tier,
# and a deploy-verify alert can wait a tick for the primary watchdog's tier-3 to re-warm DNS.
send_alert() {
  local msg="$1"
  if [ "$DRY_RUN" = "1" ]; then echo "DRY-RUN ALERT: $msg"; return 0; fi
  "$CORTEXTOS_BIN" bus send-telegram "$CHAT_ID" "$msg" >/dev/null 2>&1 && return 0
  log "bus CLI send failed — raw-curl Telegram fallback"
  [ -z "$BOT_TOKEN_FALLBACK" ] && { log "ALERT DELIVERY FAILED (no bot token for fallback)"; return 1; }
  local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/dvw-XXXXXX")" || return 1
  chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
  {
    printf 'url = "%s/bot%s/sendMessage"\n' "${TELEGRAM_API_BASE:-https://api.telegram.org}" "$BOT_TOKEN_FALLBACK"
    printf 'data-urlencode = "chat_id=%s"\n' "$CHAT_ID"
    printf 'data-urlencode = "text=%s"\n' "$msg"
    [ -n "$THREAD_ID" ] && printf 'data-urlencode = "message_thread_id=%s"\n' "$THREAD_ID"
    printf 'max-time = 15\nsilent\nshow-error\nfail\n'
  } > "$cfg"
  "$CURL" --config "$cfg" >/dev/null 2>&1 && return 0
  log "ALERT DELIVERY FAILED (bus + raw curl) — stall watchdog tier-3 owns DNS-bypass retry"
  return 1
}
CORTEXTOS_BIN="${CORTEXTOS_BIN:-/usr/bin/cortextos}"

now_epoch() { date -u +%s; }
iso_epoch() { # ISO8601 -> epoch (0 on unparseable)
  local iso="$1"; [ -z "$iso" ] || [ "$iso" = "null" ] && { echo 0; return; }
  local clean="${iso%%.*}"; clean="${clean%Z}"
  if [ "$(uname -s)" = "Darwin" ]; then
    date -j -u -f "%Y-%m-%dT%H:%M:%S" "$clean" +%s 2>/dev/null || echo 0
  else
    date -u -d "$clean" +%s 2>/dev/null || echo 0
  fi
}

fixture_or_fetch() { # fixture_var_name url key  — prints body; "" on failure
  local var="$1" url="$2" key="$3" fix=""
  [ -n "${!var:+x}" ] && fix="${!var}"
  if [ -n "$fix" ]; then cat "$fix" 2>/dev/null; return 0; fi
  local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/dvf-XXXXXX")" || return 1
  chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
  { printf 'url = "%s"\n' "$url"
    printf 'header = "Authorization: Bearer %s"\n' "$key"
    printf 'max-time = 20\nsilent\nshow-error\nfail\n'
  } > "$cfg"
  "$CURL" --config "$cfg" 2>/dev/null
}

# Per-project check. Prints "OK <verified>/<seen>" or "STALE <msg>".
project_check() {
  local label="$1" key="$2"
  # Fixtures bypass the key entirely (no network path exercised in tests).
  local depFixVar="WATCHDOG_DEPLOY_FIXTURE_${label}" runsFixVar="WATCHDOG_RUNS_FIXTURE_${label}"
  if [ -z "${!depFixVar:-}" ] && [ -z "${!runsFixVar:-}" ] && [ -z "$key" ]; then
    echo "STALE key-unavailable"; return
  fi
  local depVar="WATCHDOG_DEPLOY_FIXTURE_${label}" depJson
  depJson="$(fixture_or_fetch "$depVar" "https://api.trigger.dev/api/v1/deployments?page%5Bsize%5D=1" "$key")"
  echo "$depJson" | "$JQ" -e '.data[0]' >/dev/null 2>&1 || { echo "STALE deployments-read-failed"; return; }
  local ver depAt state
  ver="$(echo "$depJson" | "$JQ" -r '.data[0].version')"
  depAt="$(echo "$depJson" | "$JQ" -r '.data[0].deployedAt')"
  state="$(echo "$depJson" | "$JQ" -r '.data[0].status')"
  [ "$state" = "DEPLOYED" ] || { echo "OK not-deployed-yet ($state)"; return; }

  local stateFile="$STATE_DIR/dv-$label.txt"
  if [ -f "$stateFile" ] && [ "$(cat "$stateFile" 2>/dev/null)" = "$ver" ]; then
    echo "OK already-verified-$ver"; return
  fi

  local runsVar="WATCHDOG_RUNS_FIXTURE_${label}" runsJson
  runsJson="$(fixture_or_fetch "$runsVar" "https://api.trigger.dev/api/v1/runs?page%5Bsize%5D=100&filter%5Bstatus%5D=COMPLETED" "$key")"
  echo "$runsJson" | "$JQ" -e '.data' >/dev/null 2>&1 || { echo "STALE runs-read-failed"; return; }

  # First post-deploy run per task: for each distinct task, its NEWEST run overall. If the
  # newest run of a task postdates the deploy, that run's version is what the schedule
  # actually executed — exactly the question. (Older runs don't matter; the newest IS the
  # first post-deploy run whenever any exists.)
  local tsv; tsv="$(echo "$runsJson" | "$JQ" -r '.data[] | [.taskIdentifier, .version, .createdAt] | @tsv')"
  [ -n "$tsv" ] || { echo "STALE no-runs-visible"; return; }
  local seen=0 verified=0 stale="" pending=0
  local depEpoch; depEpoch="$(iso_epoch "$depAt")"
  [ "$depEpoch" -gt 0 ] || { echo "STALE bad-deployAt"; return; }
  local report; report="$(echo "$runsJson" | "$JQ" -r '
    .data |
    group_by(.taskIdentifier)[] |
    ( map(.createdAt) | max ) as $latest |
    ( map(select(.createdAt == $latest)) | .[0] ) as $newest |
    "\(.[0].taskIdentifier)\t\($newest.version)\t\($newest.createdAt)"
  ')"
  [ -n "$report" ] || { echo "STALE runs-unparseable"; return; }
  local line task v3 created
  while IFS=$'\t' read -r task v3 created; do
    [ -n "$task" ] || continue
    seen=$((seen+1))
    local cEpoch; cEpoch="$(iso_epoch "$created")"
    if [ "$cEpoch" -ge "$depEpoch" ]; then
      if [ "$v3" = "$ver" ]; then
        verified=$((verified+1))
      else
        stale="$stale $task(v$v3)"
      fi
    else
      pending=$((pending+1))
    fi
  done << EOF
$report
EOF
  [ "$seen" -gt 0 ] || { echo "STALE zero-tasks"; return; }

  if [ -n "$stale" ]; then
    echo "STALE ver=$ver stale:$stale verified=$verified/$seen pending=$pending"
    return
  fi
  if [ "$verified" -eq 0 ] && [ "$pending" -eq "$seen" ]; then
    local depAge=$(( $(now_epoch) - depEpoch ))
    [ "$depAge" -gt "$VERIFY_WINDOW_SEC" ] \
      && { echo "STALE ver=$ver no-task-ran-since-deploy (depAgeMin=$((depAge/60)), tasks=$seen)"; return; }
  fi
  if [ "$verified" -gt 0 ]; then
    [ "$DRY_RUN" = "1" ] || printf '%s' "$ver" > "$stateFile"
  fi
  echo "OK ver=$ver verified=$verified/$seen pending=$pending"
}

main() {
  for spec in "${PROJECTS[@]}"; do
    local label ref keyField
    label="${spec%%:*}"; rest="${spec#*:}"; ref="${rest%%:*}"; keyField="${rest#*:}"
    local key; key="$(get_key "$keyField")"
    local verdict; verdict="$(project_check "$label" "$key")"
    log "[$label] $verdict"
    case "$verdict" in
      STALE*)
        case "$verdict" in
          *runs-read-failed*|*deployments-read-failed*|*key-unavailable*|*no-runs-visible*|*runs-unparseable*|*bad-deployAt*|*zero-tasks*)
            # A bad read is UNKNOWN, not stale — never page on our own blindness.
            log "[$label] read failure — treated as UNKNOWN, no page"; ;;
          *)
            if [ "$DRY_RUN" = "1" ]; then echo "[$label] DRY-RUN WOULD PAGE: $verdict"
            else
              # Dedup: one page per (label,version). The state file is written by the NEXT
              # verified check; for a persistent stale we must not re-page hourly, so use
              # a separate alert-marker file.
              local marker="$STATE_DIR/dv-alert-$label-$verdict.txt"
              marker="$STATE_DIR/dv-alert-$label.txt"
              if [ ! -f "$marker" ] || [ "$(cat "$marker" 2>/dev/null)" != "$verdict" ]; then
                send_alert "deploy-verify [$label]: $verdict — scheduled tasks are NOT running the latest deploy. Investigate before trusting any automation output."
                printf '%s' "$verdict" > "$marker" 2>/dev/null
              else
                log "[$label] stale already alerted — suppressing duplicate"
              fi
            fi ;;
        esac ;;
      OK*) rm -f "$STATE_DIR/dv-alert-$label.txt" 2>/dev/null ;;
    esac
  done
  exit 0
}

main "$@"
