#!/bin/bash
# trigger-watchdog.sh — INDEPENDENT Trigger.dev outage watchdog (Layer 1a).
#
# Why: 2026-06-22 a Trigger.dev us-east-1 outage took down Hub automations AND
# the Trigger-based watchdog (it's a Trigger task), so nothing alerted. A monitor
# cannot live on the infra it monitors. This runs from the SYSTEM CRONTAB on Solo
# (NOT a cortextOS agent-prompt cron — those need the agent/LLM alive), pure shell,
# and alerts over Telegram — so it survives BOTH a Trigger.dev outage AND the
# cortextOS daemon/LLM being down. Mirrors bin/quota-watchdog.sh. NEVER spawns Claude.
#
# Layer 1a (this file): checks status.trigger.dev (no credential) and pages Bones
# when a CRITICAL Trigger.dev component is down/degraded. Layer 1b (the runs-API
# "0 EXECUTING + aging queued backlog" check) is added later once a Hub-scoped prod
# read key is minted — see vault/projects/ai/watchdog-resilience.
#
# Tunables (env):
#   TRIGGER_STATUS_URL      status JSON endpoint (default: https://status.trigger.dev/index.json)
#   TRIGGER_STATUS_FIXTURE  path to a local JSON fixture to read INSTEAD of curl (tests)
#   WATCHDOG_CRITICAL       comma list of components that PAGE on degraded/downtime
#                           (default: "Trigger.dev cloud,Trigger.dev API")
#   WATCHDOG_DRY_RUN        "1" => classify + log + print DECISION, skip send + marker writes
#   WATCHDOG_CHAT_ID        Telegram chat to alert (default: read CHAT_ID from the bus agent .env)
#   WATCHDOG_THREAD_ID      optional forum topic id (default: read TOPIC_ID from the agent .env)
#   CTX_ROOT/CTX_FRAMEWORK_ROOT/CTX_ORG/WATCHDOG_BUS_AGENT  cortextOS context (Solo defaults below)
#
# Exit codes: 0 always (cron-friendly). All errors logged.

set -uo pipefail

STATUS_URL="${TRIGGER_STATUS_URL:-https://status.trigger.dev/index.json}"
STATUS_FIXTURE="${TRIGGER_STATUS_FIXTURE:-}"
CRITICAL="${WATCHDOG_CRITICAL:-Trigger.dev cloud,Trigger.dev API}"
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

CTX_ROOT="${CTX_ROOT:-/home/bones/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/home/bones/cortextos}"
CTX_ORG="${CTX_ORG:-vault}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-solo}"

STATE_DIR="$CTX_ROOT/state/trigger-watchdog"
MARKER="$STATE_DIR/incident-active.json"   # present => an incident alert is outstanding
LOG="$STATE_DIR/watchdog.log"
mkdir -p "$STATE_DIR"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Bus env block — cron has no agent context; bus send-telegram resolves the bot
# token from this agent's .env (src/cli/bus.ts).
export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS="${CORTEXTOS_BIN:-/usr/bin/cortextos}"
JQ="${JQ_BIN:-$(command -v jq 2>/dev/null || echo /usr/bin/jq)}"
CURL="${CURL_BIN:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"
# Hard prereqs — fail loudly (in the log), never silently mis-classify.
if ! command -v "$JQ" >/dev/null 2>&1 || ! command -v "$CURL" >/dev/null 2>&1; then
  log "FATAL: jq or curl not found (jq=$JQ curl=$CURL) — cannot run watchdog"; exit 0
fi

# Resolve the alert chat + (optional) topic + raw-curl-fallback token from the
# agent .env unless overridden. Read without sourcing (values may contain spaces).
AGENT_ENV="$CTX_AGENT_DIR/.env"
env_get() { [ -f "$AGENT_ENV" ] && sed -n "s/^$1=//p" "$AGENT_ENV" | head -1 | tr -d '"'; }
CHAT_ID="${WATCHDOG_CHAT_ID:-$(env_get CHAT_ID)}"
THREAD_ID="${WATCHDOG_THREAD_ID:-$(env_get TOPIC_ID)}"
BOT_TOKEN_FALLBACK="$(env_get BOT_TOKEN)"

# ---------------------------------------------------------------------------
# Alert sender: prefer the cortextOS bus CLI (--plain-text — alert bodies carry
# _/%/<>/URLs that trip Telegram HTML parse). If the CLI itself is broken (Node /
# dist gone), fall back to a raw Telegram curl with the same token, so an alert
# still lands when cortextOS-the-CLI is down (true independence).
# ---------------------------------------------------------------------------
send_alert() {
  local msg="$1"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN alert: $msg"; return 0; fi
  local args=("$CHAT_ID" "$msg" --plain-text)
  [ -n "$THREAD_ID" ] && args+=(--thread "$THREAD_ID")
  if [ -x "$CORTEXTOS" ] && "$CORTEXTOS" bus send-telegram "${args[@]}" >/dev/null 2>&1; then
    log "alert sent via bus CLI"
    return 0
  fi
  log "bus CLI send failed — raw-curl Telegram fallback"
  if [ -n "$BOT_TOKEN_FALLBACK" ]; then
    # Token MUST go in the Telegram URL path. Keep it OUT of argv (ps-visible) by
    # passing everything through a 0600 curl --config file, removed immediately.
    local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/twd-XXXXXX")" || return 1
    chmod 600 "$cfg"
    {
      printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$BOT_TOKEN_FALLBACK"
      printf 'data-urlencode = "chat_id=%s"\n' "$CHAT_ID"
      printf 'data-urlencode = "text=%s"\n' "$msg"
      [ -n "$THREAD_ID" ] && printf 'data-urlencode = "message_thread_id=%s"\n' "$THREAD_ID"
      printf 'max-time = 15\nsilent\nshow-error\nfail\n'
    } > "$cfg"
    local ok=1
    "$CURL" --config "$cfg" >/dev/null 2>&1 && ok=0
    rm -f "$cfg"
    if [ "$ok" = 0 ]; then log "alert sent via raw-curl fallback"; return 0; fi
  fi
  log "ALERT DELIVERY FAILED (both bus CLI and raw curl)"
  return 1
}

# Atomic marker write (jq-escaped, temp+rename) — never corrupts on overlap/odd chars.
write_marker() {
  local since="$1" reason="$2" tmp
  tmp="$(mktemp "$STATE_DIR/.marker-XXXXXX")" || return 1
  "$JQ" -n --arg since "$since" --arg last "$(ts)" --arg reason "$reason" \
    '{since:$since,last:$last,reason:$reason}' > "$tmp" && mv -f "$tmp" "$MARKER"
}

# ---------------------------------------------------------------------------
# Fetch the status JSON (fixture for tests, else curl with a timeout).
# ---------------------------------------------------------------------------
fetch_status() {
  if [ -n "$STATUS_FIXTURE" ]; then cat "$STATUS_FIXTURE" 2>/dev/null; return $?; fi
  "$CURL" -fsS --max-time 20 "$STATUS_URL" 2>/dev/null
}

JSON="$(fetch_status)"
if [ -z "$JSON" ] || ! echo "$JSON" | "$JQ" -e . >/dev/null 2>&1; then
  # Can't reach/parse the status page. Ambiguous (could be Solo's own network), so
  # do NOT page on it — log only. 1b's runs-API check corroborates a real outage.
  log "status fetch/parse failed (url=$STATUS_URL) — not paging (ambiguous)"
  exit 0
fi

AGG="$(echo "$JSON" | "$JQ" -r '.data.attributes.aggregate_state // "unknown"')"

# Critical components currently degraded/downtime (the allowlist that PAGES).
CRIT_JSON="$(echo "$CRITICAL" | "$JQ" -R 'split(",") | map(gsub("^\\s+|\\s+$";""))')"
BAD_CRIT="$(echo "$JSON" | "$JQ" -r --argjson crit "$CRIT_JSON" '
  [ .included[]?
    | select(.type=="status_page_resource")
    | {name: .attributes.public_name, status: (.attributes.status // "operational")}
    | select(.status=="downtime" or .status=="degraded")
    | select(.name as $n | $crit | index($n))
    | "\(.name)=\(.status)" ] | join(", ")')"

# Decision: page on aggregate downtime, or any CRITICAL component down/degraded.
# Non-critical components (Realtime/OTel/Deployments) are context only — no page.
DECISION="OK"; REASON=""
if [ "$AGG" = "downtime" ]; then
  DECISION="PAGE"; REASON="aggregate_state=downtime"
elif [ -n "$BAD_CRIT" ]; then
  DECISION="PAGE"; REASON="critical component(s): $BAD_CRIT"
elif [ "$AGG" = "degraded" ]; then
  DECISION="OK"; REASON="aggregate degraded but no critical component affected (context only)"
fi
log "check: aggregate=$AGG decision=$DECISION ${REASON:+($REASON)}"
[ "$DRY_RUN" = "1" ] && echo "DECISION=$DECISION REASON=$REASON"

DASH="https://status.trigger.dev"
PENDING="$STATE_DIR/pending.count"
if [ "$DECISION" = "PAGE" ]; then
  if [ -f "$MARKER" ]; then
    # Already alerted this incident — re-derive each run, refresh the marker ts.
    [ "$DRY_RUN" = "1" ] || write_marker "$("$JQ" -r .since "$MARKER" 2>/dev/null || ts)" "$REASON"
    log "incident ongoing (already alerted): $REASON"
  else
    # Debounce flapping: require the PAGE condition on >=2 consecutive cycles
    # before the first alert (one transient blip shouldn't page).
    cnt=0; [ -f "$PENDING" ] && cnt="$(cat "$PENDING" 2>/dev/null || echo 0)"
    cnt=$((cnt + 1))
    [ "$DRY_RUN" = "1" ] || echo "$cnt" > "$PENDING"
    if [ "$cnt" -lt 2 ]; then
      log "PAGE condition seen (cycle $cnt/2) — debouncing before alert: $REASON"
    elif send_alert "🔴 Trigger.dev outage detected ($REASON). Hub automations (RFC classify, budget extension, syncs) may be stalled. Check $DASH . The Solo watchdog will say when it recovers."; then
      [ "$DRY_RUN" = "1" ] || { write_marker "$(ts)" "$REASON"; rm -f "$PENDING"; }
    fi
  fi
else
  # Healthy cycle: reset the debounce counter.
  [ "$DRY_RUN" = "1" ] || rm -f "$PENDING"
  if [ -f "$MARKER" ]; then
    since="$("$JQ" -r .since "$MARKER" 2>/dev/null)"
    # Only clear the marker if the recovery message actually delivered — else a
    # transient send failure would permanently suppress the recovery notice.
    if send_alert "🟢 Trigger.dev recovered (aggregate_state=$AGG). Outage started $since. Hub automations should be flowing again."; then
      [ "$DRY_RUN" = "1" ] || rm -f "$MARKER"
      log "incident cleared (recovery sent), was since $since"
    else
      log "recovery send FAILED — keeping marker, will retry next tick"
    fi
  fi
fi

exit 0
