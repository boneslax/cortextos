#!/bin/bash
# trigger-watchdog.sh — INDEPENDENT Trigger.dev IMPACT watchdog (Layer 1b + 1a-context).
#
# Why: 2026-06-22 a Trigger.dev us-east-1 outage stalled Hub automations AND the
# Trigger-based watchdog (it's a Trigger task). A monitor can't live on the infra it
# monitors. Runs from the SYSTEM CRONTAB on Solo (NOT a cortextOS agent-prompt cron —
# those need the agent/LLM alive), pure shell, alerts over Telegram — so it survives
# BOTH a Trigger.dev outage AND the cortextOS daemon/LLM being down. NEVER spawns Claude.
#
# 1b (PRIMARY, impact-aware — Bones's requirement "check if MY automations are impacted
# before alerting"): query BOTH Hub prod Trigger projects' runs and PAGE only when HIS
# prod is actually STALLED — sustained EXECUTING==0 + an aging QUEUED backlog + nothing
# COMPLETED recently (the exact 6/22 signature). A momentary 0-executing snapshot is
# NORMAL (per-minute cron ticks) and must NOT page — hence the age + last-completed gates
# + the >=2-cycle debounce.
# 1a (now CONTEXT, not the trigger): status.trigger.dev is fetched for context only;
# status-degraded-while-his-prod-executes is INFO, never a page (it over-paged on a
# non-used-region flap on 2026-06-24). Region-awareness falls out for free: if his runs
# execute, no page, regardless of which region the status page flags.
#
# Tunables (env):
#   WATCHDOG_STALL_MIN     minutes: oldest-queued-age AND last-completed-age must BOTH
#                          exceed this to call a project STALLED (default 10)
#   WATCHDOG_MIN_QUEUED    queued count that counts as a backlog (default 1)
#   WATCHDOG_DRY_RUN       "1" => classify + log + print DECISION, skip send + state writes
#   WATCHDOG_STATUS_FIXTURE / WATCHDOG_RUNS_FIXTURE_<LABEL>_<STATUS>  test injection (read a
#                          local JSON fixture instead of curling status / a project's runs)
#   TELEGRAM_API_BASE      override the Telegram API base (tests point it at a dead endpoint)
#   WATCHDOG_CHAT_ID / WATCHDOG_THREAD_ID            alert target (default: solo agent .env)
#   OP_SA_TOKEN_FILE       1Password service-account token (default ~/.config/opbot/sa-token)
#   CTX_ROOT/CTX_FRAMEWORK_ROOT/CTX_ORG/WATCHDOG_BUS_AGENT  cortextOS context (Solo defaults)
#
# Projects monitored (label:projectRef:1pw-field): hubapp (primary) + helpdesk (secondary).
# Exit codes: 0 always (cron-friendly). All errors logged.

set -uo pipefail

DRY_RUN="${WATCHDOG_DRY_RUN:-0}"
STALL_MIN="${WATCHDOG_STALL_MIN:-10}"
MIN_QUEUED="${WATCHDOG_MIN_QUEUED:-1}"
STATUS_URL="${TRIGGER_STATUS_URL:-https://status.trigger.dev/index.json}"
STATUS_FIXTURE="${WATCHDOG_STATUS_FIXTURE:-}"

CTX_ROOT="${CTX_ROOT:-/home/bones/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/home/bones/cortextos}"
CTX_ORG="${CTX_ORG:-vault}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-solo}"
OP_SA_TOKEN_FILE="${OP_SA_TOKEN_FILE:-$HOME/.config/opbot/sa-token}"
OP_ITEM="chagb6unxtfqljbcrxu4pxmqxe"   # 1Password 'Trigger.dev' (PKM Automation)

# label:projectRef:1password-field  (hubapp = primary impact target)
PROJECTS=(
  "hubapp:proj_luyejwcyhjfojxxgwlit:hubapp_prod_read_key"
  "helpdesk:proj_dmalyhsdqqxehlagufef:helpdesk_prod_read_key"
)

STATE_DIR="$CTX_ROOT/state/trigger-watchdog"
LOG="$STATE_DIR/watchdog.log"
mkdir -p "$STATE_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS="${CORTEXTOS_BIN:-/usr/bin/cortextos}"
JQ="${JQ_BIN:-$(command -v jq 2>/dev/null || echo /usr/bin/jq)}"
CURL="${CURL_BIN:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"
OP="${OP_BIN:-$(command -v op 2>/dev/null || echo /usr/bin/op)}"
if ! command -v "$JQ" >/dev/null 2>&1 || ! command -v "$CURL" >/dev/null 2>&1; then
  log "FATAL: jq or curl not found (jq=$JQ curl=$CURL)"; exit 0
fi

AGENT_ENV="$CTX_AGENT_DIR/.env"
env_get() { [ -f "$AGENT_ENV" ] && sed -n "s/^$1=//p" "$AGENT_ENV" | head -1 | tr -d '"'; }
CHAT_ID="${WATCHDOG_CHAT_ID:-$(env_get CHAT_ID)}"
THREAD_ID="${WATCHDOG_THREAD_ID:-$(env_get TOPIC_ID)}"
BOT_TOKEN_FALLBACK="$(env_get BOT_TOKEN)"

send_alert() {
  local msg="$1"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN alert: $msg"; return 0; fi
  local args=("$CHAT_ID" "$msg" --plain-text)
  [ -n "$THREAD_ID" ] && args+=(--thread "$THREAD_ID")
  if [ -x "$CORTEXTOS" ] && "$CORTEXTOS" bus send-telegram "${args[@]}" >/dev/null 2>&1; then
    log "alert sent via bus CLI"; return 0
  fi
  log "bus CLI send failed — raw-curl Telegram fallback"
  if [ -n "$BOT_TOKEN_FALLBACK" ]; then
    local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/twd-XXXXXX")" || return 1
    chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
    {
      # TELEGRAM_API_BASE override (default real) lets tests point the raw-curl
      # fallback at a dead endpoint so a send is structurally impossible.
      printf 'url = "%s/bot%s/sendMessage"\n' "${TELEGRAM_API_BASE:-https://api.telegram.org}" "$BOT_TOKEN_FALLBACK"
      printf 'data-urlencode = "chat_id=%s"\n' "$CHAT_ID"
      printf 'data-urlencode = "text=%s"\n' "$msg"
      [ -n "$THREAD_ID" ] && printf 'data-urlencode = "message_thread_id=%s"\n' "$THREAD_ID"
      printf 'max-time = 15\nsilent\nshow-error\nfail\n'
    } > "$cfg"
    local ok=1; "$CURL" --config "$cfg" >/dev/null 2>&1 && ok=0; rm -f "$cfg"
    [ "$ok" = 0 ] && { log "alert sent via raw-curl fallback"; return 0; }
  fi
  log "ALERT DELIVERY FAILED (both bus CLI and raw curl)"; return 1
}

age_secs() { # iso8601 -> seconds ago (echo big number if empty/unparseable)
  local iso="$1"; [ -z "$iso" ] || [ "$iso" = "null" ] && { echo 999999999; return; }
  local e; e="$(date -u -d "$iso" +%s 2>/dev/null)" || { echo 999999999; return; }
  echo $(( $(date -u +%s) - e ))
}

# Fetch a project's runs for a status. Honors WATCHDOG_RUNS_FIXTURE_<LABEL>_<STATUS>
# (a file path) for tests so no key/network is needed.
fetch_runs() {
  local label="$1" key="$2" status="$3"
  local fix; fix="$(eval echo "\${WATCHDOG_RUNS_FIXTURE_${label}_${status}:-}")"
  if [ -n "$fix" ]; then cat "$fix" 2>/dev/null; return 0; fi
  local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/twr-XXXXXX")" || return 1
  chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
  {
    printf 'url = "https://api.trigger.dev/api/v1/runs?filter[status]=%s&page[size]=20"\n' "$status"
    printf 'header = "Authorization: Bearer %s"\n' "$key"
    printf 'globoff\nmax-time = 20\nsilent\nfail\n'
  } > "$cfg"
  "$CURL" --config "$cfg" 2>/dev/null; rm -f "$cfg"
}

# Per-project impact check. Echoes: "<VERDICT> exec=<n> queued=<n> doneAgeMin=<n>"
# VERDICT=STALL|OK|UNKNOWN. STALL = exec==0 AND queued>=MIN AND last-completed-age>STALL_MIN
# (his prod has nothing executing, a queued backlog, and nothing has finished in STALL_MIN).
# NOTE on pagination (gate review): we deliberately gate on LAST-COMPLETED age, not oldest-
# queued age. COMPLETED is returned newest-first, so max(finishedAt) over the first page is the
# true newest completion (accurate regardless of how deep the backlog is). "oldest queued age"
# would need the true oldest, which a newest-first page of a >page-size backlog can't give —
# so it's dropped from the gate (kept out to avoid a false-negative). The >=2-cycle debounce
# rejects a fresh queued burst (it would start completing by cycle 2). queued>=MIN only needs
# "is there a backlog at all", which a page reports accurately.
project_check() {
  local label="$1" key="$2"
  local execJson queuedJson doneJson exec queued doneNewest doneAge thr
  thr=$((STALL_MIN * 60))
  execJson="$(fetch_runs "$label" "$key" EXECUTING)"
  queuedJson="$(fetch_runs "$label" "$key" QUEUED)"
  doneJson="$(fetch_runs "$label" "$key" COMPLETED)"
  # any fetch unparseable -> UNKNOWN (don't page on a bad read)
  for j in "$execJson" "$queuedJson" "$doneJson"; do
    echo "$j" | "$JQ" -e '.data' >/dev/null 2>&1 || { echo "UNKNOWN exec=- queued=- doneAgeMin=-"; return; }
  done
  exec="$(echo "$execJson" | "$JQ" '.data | length')"
  queued="$(echo "$queuedJson" | "$JQ" '.data | length')"
  doneNewest="$(echo "$doneJson" | "$JQ" -r '[.data[].finishedAt] | max // ""')"
  doneAge="$(age_secs "$doneNewest")"
  local verdict="OK"
  if [ "$exec" -eq 0 ] && [ "$queued" -ge "$MIN_QUEUED" ] && [ "$doneAge" -gt "$thr" ]; then
    verdict="STALL"
  fi
  echo "$verdict exec=$exec queued=$queued doneAgeMin=$((doneAge/60))"
}

# Resolve both project read keys from 1Password (unless a fixture is supplying runs).
get_key() {
  local field="$1"
  [ -f "$OP_SA_TOKEN_FILE" ] || { echo ""; return; }
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$OP_SA_TOKEN_FILE")" "$OP" --vault="PKM Automation" \
    item get "$OP_ITEM" --fields "$field" --reveal 2>/dev/null
}

# ---- 1a status.trigger.dev as CONTEXT (never the trigger) ----
STATUS_CTX="status:unknown"
if [ -n "$STATUS_FIXTURE" ]; then SJSON="$(cat "$STATUS_FIXTURE" 2>/dev/null)";
else SJSON="$("$CURL" -fsS --max-time 20 "$STATUS_URL" 2>/dev/null)"; fi
if echo "$SJSON" | "$JQ" -e . >/dev/null 2>&1; then
  agg="$(echo "$SJSON" | "$JQ" -r '.data.attributes.aggregate_state // "unknown"')"
  STATUS_CTX="status:$agg"
fi

# ---- 1b impact check across both projects ----
STALLED_NOW=(); CONTEXT_LINES=""
for spec in "${PROJECTS[@]}"; do
  label="${spec%%:*}"; rest="${spec#*:}"; field="${rest##*:}"   # projref is implied by the project-scoped key
  fixset="$(eval echo "\${WATCHDOG_RUNS_FIXTURE_${label}_EXECUTING:-}")"
  if [ -n "$fixset" ]; then key="FIXTURE"; else key="$(get_key "$field")"; fi
  if [ -z "$key" ]; then
    log "[$label] no read key (1Password $field) — impact-check unavailable; NOT paging"
    CONTEXT_LINES="$CONTEXT_LINES\n$label: key-unavailable"
    continue
  fi
  res="$(project_check "$label" "$key")"
  log "[$label] $res ($STATUS_CTX)"
  CONTEXT_LINES="$CONTEXT_LINES\n$label: $res"
  [ "${res%% *}" = "STALL" ] && STALLED_NOW+=("$label")
done
[ "$DRY_RUN" = "1" ] && echo "DECISION=$([ "${#STALLED_NOW[@]}" -gt 0 ] && echo PAGE || echo OK) STALLED=[${STALLED_NOW[*]:-}] $STATUS_CTX"

# ---- decide: PER-PROJECT debounce (>=2 consecutive cycles) + per-project marker ----
# Each project alerts/recovers independently — a hubapp-then-helpdesk flap across two
# cycles must NOT page (neither stalled 2 cycles in a row).
is_stalled() { local x; for x in "${STALLED_NOW[@]:-}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
NEWLY=(); RECOVERED=()
for spec in "${PROJECTS[@]}"; do
  label="${spec%%:*}"; pend="$STATE_DIR/pending.$label"; mk="$STATE_DIR/incident.$label.json"
  if is_stalled "$label"; then
    if [ -f "$mk" ]; then
      log "[$label] stall ongoing (already alerted)"
    else
      cnt=0; [ -f "$pend" ] && cnt="$(cat "$pend" 2>/dev/null || echo 0)"; cnt=$((cnt+1))
      [ "$DRY_RUN" = "1" ] || echo "$cnt" > "$pend"
      if [ "$cnt" -ge 2 ]; then NEWLY+=("$label"); else log "[$label] stall cycle $cnt/2 — debouncing"; fi
    fi
  else
    [ "$DRY_RUN" = "1" ] || rm -f "$pend"
    [ -f "$mk" ] && RECOVERED+=("$label")
  fi
done

if [ "${#NEWLY[@]}" -gt 0 ]; then
  if send_alert "$(printf '🔴 Hub automations STALLED in Trigger.dev prod: %s. No executing runs + an aging queued backlog (>%dm) + nothing completing. Context %s.%b\nThe watchdog will report recovery.' "${NEWLY[*]}" "$STALL_MIN" "$STATUS_CTX" "$CONTEXT_LINES")"; then
    [ "$DRY_RUN" = "1" ] || for l in "${NEWLY[@]}"; do mt="$(mktemp "$STATE_DIR/.m-XXXXXX")"; "$JQ" -n --arg s "$(ts)" --arg ll "$(ts)" '{since:$s,last:$ll}' > "$mt" && mv -f "$mt" "$STATE_DIR/incident.$l.json"; rm -f "$STATE_DIR/pending.$l"; done
  fi
fi
if [ "${#RECOVERED[@]}" -gt 0 ]; then
  if send_alert "🟢 Hub automations RECOVERED in Trigger.dev prod: ${RECOVERED[*]} — executing again. $STATUS_CTX."; then
    [ "$DRY_RUN" = "1" ] || for l in "${RECOVERED[@]}"; do rm -f "$STATE_DIR/incident.$l.json"; done
    log "recovery sent: ${RECOVERED[*]}"
  else
    log "recovery send FAILED — keeping markers, retry next tick"
  fi
fi
exit 0
