#!/bin/bash
# ops-drain-staleness.sh — "watch the watcher" for the ops-triage drainer (Layer 2).
#
# Why: bin/ops-triage-drain.sh touches $STATE/heartbeat on every tick that actually
# completed a healthy drain, and DELIBERATELY does NOT touch it when it is fully bricked
# (every outbox item faulted) or when it died — so a stale heartbeat is a real signal that
# no evidence is being routed. That drainer is itself a system-cron script; nothing was
# watching IT. This watcher runs from the SYSTEM CRONTAB on Solo (pure bash, never spawns
# Claude, survives the daemon/LLM being down — same reasoning as bin/trigger-watchdog.sh)
# and pages Bones over Telegram when the heartbeat goes stale. A silently-dead or fully-
# bricked drainer is otherwise invisible.
#
# THE SECURITY BOUNDARY (why the reviewer attacks this): the page TARGET (chat id / token)
# comes ONLY from the solo agent .env / pinned env — NEVER from any file content. This
# watcher reads the heartbeat's MTIME ONLY (`stat -c %Y`), never its bytes. It does NOT
# cat / read / parse the heartbeat file. So there is no untrusted-input path that could
# steer the alert anywhere: the message text is fixed, the target is env-resolved. A
# monitoring alert that can be redirected is an external-write hazard; a mtime-only stat
# cannot be redirected by whatever the drainer (or anything else) wrote into the file.
#
# Tunables (env):
#   OPS_DRAIN_STATE_DIR    the DRAINER's state dir (default $CTX_ROOT/state/ops-triage-drain).
#                          MUST resolve the same way the drainer does so we stat the SAME
#                          heartbeat path it writes.
#   OPS_DRAIN_STALE_SEC    staleness threshold in seconds (default 1800 = 30m = 3 missed
#                          */10 drainer ticks).
#   OPS_DRAIN_REALERT_SEC  re-alert cadence for a sustained stale condition (default 3600).
#   OPS_DRAIN_DRY_RUN=1    classify + log + print DECISION; no send, no marker writes.
#   OPS_DRAIN_CHAT_ID / OPS_DRAIN_THREAD_ID  alert target (default: solo agent .env).
#   CORTEXTOS_BIN          cortextOS CLI (tests point it at a fake stub / /nonexistent).
#   TELEGRAM_API_BASE      Telegram base (tests point it at a dead endpoint).
#   OP_SA_TOKEN_FILE       1Password service-account token file.
#   CTX_ROOT/CTX_FRAMEWORK_ROOT/CTX_ORG  cortextOS context (Solo defaults).
#
# Exit code: always 0 (cron-friendly). All errors are logged. Deliberately NOT `set -e`:
# a missing heartbeat is the ALERT case, not an abort case, and the tick must always
# exit 0 — same convention as bin/trigger-watchdog.sh and bin/ops-triage-drain.sh.

set -uo pipefail

DRY_RUN="${OPS_DRAIN_DRY_RUN:-0}"
STALE_SEC="${OPS_DRAIN_STALE_SEC:-1800}"
REALERT_SEC="${OPS_DRAIN_REALERT_SEC:-3600}"
# Every numeric tunable is arithmetic-compared later. A non-numeric value from the
# environment must not make `[ x -gt y ]` error the whole tick — fall back to the default.
case "$STALE_SEC"   in ''|*[!0-9]*) STALE_SEC=1800   ;; esac
case "$REALERT_SEC" in ''|*[!0-9]*) REALERT_SEC=3600 ;; esac

# --- pinned cortextOS context (same resolution as bin/ops-triage-drain.sh) ----
PIN_ORG="${CTX_ORG:-vault}"
PIN_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
PIN_FWROOT="${CTX_FRAMEWORK_ROOT:-$HOME/cortextos}"

# SAME $STATE resolution as the drainer, so HB is the SAME file the drainer touches.
STATE="${OPS_DRAIN_STATE_DIR:-$PIN_ROOT/state/ops-triage-drain}"
HB="$STATE/heartbeat"
LOG="$STATE/staleness.log"

mkdir -p "$STATE" 2>/dev/null
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

if [ "$DRY_RUN" != "1" ]; then
  command -v flock >/dev/null 2>&1 || { log "FATAL: flock not found"; exit 0; }
  exec 9>"$STATE/staleness.lock"
  flock -n 9 || { log "SKIP — prior staleness tick still running"; exit 0; }
fi

CORTEXTOS="${CORTEXTOS_BIN:-/usr/bin/cortextos}"
JQ="${JQ_BIN:-$(command -v jq 2>/dev/null || echo /usr/bin/jq)}"
CURL="${CURL_BIN:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"

if ! command -v "$JQ" >/dev/null 2>&1; then log "FATAL: jq not found ($JQ)"; exit 0; fi

# --- alerting -----------------------------------------------------------------
# Alert target comes from the agent .env exactly like trigger-watchdog.sh / ops-triage-
# drain.sh. In tests the framework root is an EMPTY dir, so no .env exists, so no BOT_TOKEN
# is ever resolved — a real send is structurally impossible, not merely disabled by a flag.
AGENT_ENV="$PIN_FWROOT/orgs/$PIN_ORG/agents/solo/.env"
env_get() { [ -f "$AGENT_ENV" ] && sed -n "s/^$1=//p" "$AGENT_ENV" | head -1 | tr -d '"'; }
CHAT_ID="${OPS_DRAIN_CHAT_ID:-$(env_get CHAT_ID)}"
THREAD_ID="${OPS_DRAIN_THREAD_ID:-$(env_get TOPIC_ID)}"
BOT_TOKEN_FALLBACK="$(env_get BOT_TOKEN)"

# The alert message is a FIXED string (plus $STALE_MIN and $STATE, both env-derived). No
# user- or file-controlled text ever reaches here — the whole point of the mtime-only read
# is that nothing from the heartbeat's bytes can influence what is sent or where.
send_alert() {
  # Defense-in-depth (mirrors ops-triage-drain.sh's san() + tr -d '"' choke point): strip
  # control chars + double quotes before $msg can ever reach a curl --config line, where a
  # newline opens a new directive and a quote terminates the quoted value early. Today $msg
  # is built only from a fixed string plus $STALE_MIN/$STATE (both env-derived, not file-
  # derived) so this is not exploitable yet — the point is that a future edit letting a
  # file-derived value into the message can't become a curl-config injection by surprise.
  local msg; msg="$(printf '%s' "${1:-}" | tr -d '[:cntrl:]"')"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN alert: $msg"; return 0; fi
  local args=("$CHAT_ID" "$msg" --plain-text)
  [ -n "$THREAD_ID" ] && args+=(--thread "$THREAD_ID")
  if [ -x "$CORTEXTOS" ] && "$CORTEXTOS" bus send-telegram "${args[@]}" >/dev/null 2>&1; then
    log "alert sent via bus CLI"; return 0
  fi
  log "bus CLI send failed — raw-curl Telegram fallback"
  if [ -n "$BOT_TOKEN_FALLBACK" ]; then
    local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/ods-XXXXXX")" || return 1
    chmod 600 "$cfg"
    {
      # TELEGRAM_API_BASE override (default real) lets tests point the raw-curl fallback at
      # a dead endpoint so a send is structurally impossible.
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

# Per-condition marker + re-alert cadence + one-shot recovery (mirrors ops-triage-drain.sh).
# Never one-and-done (a sustained stale drainer must keep nagging), never every-tick spam.
# On a FAILED delivery we persist last=0 so the next tick retries immediately instead of
# going quiet for a whole cadence window on a transient network blip.
alert_cond() {
  local key="$1" msg="$2"; local mk="$STATE/alert.$key.json"
  local now since last newlast tmp
  now="$(date -u +%s)"; since="$now"; last=0
  if [ -f "$mk" ]; then
    since="$("$JQ" -r '.since // empty' "$mk" 2>/dev/null)"; [ -z "$since" ] && since="$now"
    last="$("$JQ" -r '.last // 0' "$mk" 2>/dev/null)"; [ -z "$last" ] && last=0
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ "$last" -gt 0 ] && [ $((now - last)) -lt "$REALERT_SEC" ]; then
      log "[$key] condition ongoing — alert suppressed by cadence"; return 0
    fi
  fi
  newlast="$now"; send_alert "$msg" || newlast=0
  [ "$DRY_RUN" = "1" ] && return 0
  tmp="$(mktemp "$STATE/.a-XXXXXX")" || return 0
  "$JQ" -n --argjson s "$since" --argjson l "$newlast" '{since:$s,last:$l}' > "$tmp" \
    && mv -f "$tmp" "$mk" || rm -f "$tmp"
}

clear_cond() {
  local key="$1" msg="$2"; local mk="$STATE/alert.$key.json"
  [ -f "$mk" ] || return 0
  log "[$key] condition cleared — sending recovery"
  if send_alert "$msg"; then
    [ "$DRY_RUN" = "1" ] || rm -f "$mk"
    log "[$key] recovery sent"
  else
    log "[$key] recovery send FAILED — keeping marker, retry next tick"
  fi
}

# --- staleness check: MTIME ONLY, never the file's bytes ----------------------
# `stat -c %Y "$HB"` reads inode metadata (mtime) only. There is no code path that opens
# the heartbeat's contents, so nothing written into the file — by the drainer or by anyone
# who can write $STATE — can influence the alert or its target.
STALE_MIN=$(( STALE_SEC / 60 ))
now="$(date -u +%s)"
stale=0
if [ ! -f "$HB" ]; then
  reason="heartbeat ABSENT ($HB)"
  stale=1
else
  mtime="$(stat -c %Y "$HB" 2>/dev/null)"
  case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac   # unreadable mtime => treat as stale
  age=$(( now - mtime ))
  if [ "$age" -gt "$STALE_SEC" ]; then
    reason="heartbeat STALE (age ${age}s > ${STALE_SEC}s)"
    stale=1
  else
    reason="heartbeat fresh (age ${age}s <= ${STALE_SEC}s)"
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DECISION=$([ "$stale" -eq 1 ] && echo PAGE || echo OK) $reason"
fi

if [ "$stale" -eq 1 ]; then
  log "STALE — $reason"
  alert_cond drainstale "🔴 ops-triage drainer heartbeat STALE (>${STALE_MIN}m) — the drainer is not running or is fully bricked; no evidence is being routed. Check the */10 cron + $STATE on Solo."
else
  log "OK — $reason"
  clear_cond drainstale "🟢 ops-triage drainer heartbeat is fresh again — the drainer is ticking; evidence routing resumed."
fi

exit 0
