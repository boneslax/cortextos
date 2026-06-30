#!/bin/bash
# disk-watchdog.sh — INDEPENDENT Solo host disk-space watchdog (deterministic, pure shell).
#
# Why: 2026-06-30 Solo's root disk hit 100% (gnome-keyring-daemon FD-leak log-spammed
# /var/log/auth.log + syslog to 355G). The full disk broke Claude's command output AND made
# the Trigger watchdog read UNKNOWN — a silent host failure that masqueraded as a Trigger
# outage. Nothing was watching host disk. This fixes that: a SYSTEM-CRON pure-shell monitor
# (no cortextOS/LLM dependency, NEVER spawns Claude) that pages Bones on Telegram BEFORE the
# disk fills, and names the runaway file so the fix is one command.
#
# Deterministic gate (same inputs -> same output, no judgment):
#   PAGE when  use% >= DISK_PAGE_PCT (default 90)   OR   any /var/log file >= RUNAWAY_GB (25)
#   (the runaway-file trigger catches a single ballooning log EARLY, before % hits the wall —
#    the exact 6/30 failure mode). Sustained >=2 cycles (debounce) before paging; per-trigger
#    marker so it alerts once; recovery message when back under DISK_WARN_PCT and no runaway file.
#
# Tunables (env):
#   DISK_PAGE_PCT   page at/above this root-fs use% (default 90)
#   DISK_WARN_PCT   recovery clears below this use% (default 80); logged as WARN between warn..page
#   RUNAWAY_GB      a single /var/log file at/above this size pages early (default 25)
#   DISK_MOUNT      filesystem to watch (default /)
#   DISK_WATCHDOG_DRY_RUN  "1" => classify + log + print DECISION, skip send + state writes
#   DISK_DF_FIXTURE / DISK_LOGSIZE_FIXTURE  test injection (use% int / "<bytes> <path>") — no real df/scan
#   TELEGRAM_API_BASE  override Telegram API base (tests point it at a dead endpoint)
#   WATCHDOG_CHAT_ID / WATCHDOG_THREAD_ID  alert target (default: solo agent .env)
#   CTX_ROOT/CTX_FRAMEWORK_ROOT/CTX_ORG/WATCHDOG_BUS_AGENT  cortextOS context (Solo defaults)
# Exit codes: 0 always (cron-friendly). All errors logged.

set -uo pipefail

DRY_RUN="${DISK_WATCHDOG_DRY_RUN:-0}"
PAGE_PCT="${DISK_PAGE_PCT:-90}"
WARN_PCT="${DISK_WARN_PCT:-80}"
RUNAWAY_GB="${RUNAWAY_GB:-25}"
MOUNT="${DISK_MOUNT:-/}"
SCAN_DIR="${DISK_SCAN_DIR:-/var/log}"
DF_FIXTURE="${DISK_DF_FIXTURE:-}"
LOGSIZE_FIXTURE="${DISK_LOGSIZE_FIXTURE:-}"

CTX_ROOT="${CTX_ROOT:-/home/bones/.cortextos/default}"
CTX_FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-/home/bones/cortextos}"
CTX_ORG="${CTX_ORG:-vault}"
BUS_AGENT="${WATCHDOG_BUS_AGENT:-solo}"

STATE_DIR="$CTX_ROOT/state/disk-watchdog"
LOG="$STATE_DIR/watchdog.log"
mkdir -p "$STATE_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Validate numeric tunables — a typo'd env var must NOT blind the watchdog (a non-numeric
# threshold would break the `-ge` compare → false-negative) or break arithmetic under set -u
# (exit 1, violating the exit-0-always cron contract). Fall back to the documented default.
numdef() {
  case "$2" in
    ''|*[!0-9]*) log "WARN: $1='$2' is not a positive integer — using default $3"; printf '%s' "$3"; return ;;
  esac
  if [ "$2" -gt 0 ]; then printf '%s' "$2"; else log "WARN: $1='$2' must be > 0 — using default $3"; printf '%s' "$3"; fi
}
PAGE_PCT="$(numdef DISK_PAGE_PCT "$PAGE_PCT" 90)"
WARN_PCT="$(numdef DISK_WARN_PCT "$WARN_PCT" 80)"
RUNAWAY_GB="$(numdef RUNAWAY_GB "$RUNAWAY_GB" 25)"

export CTX_ROOT CTX_FRAMEWORK_ROOT CTX_ORG
export CTX_AGENT_NAME="$BUS_AGENT"
export CTX_AGENT_DIR="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/$BUS_AGENT"

CORTEXTOS="${CORTEXTOS_BIN:-/usr/bin/cortextos}"
CURL="${CURL_BIN:-$(command -v curl 2>/dev/null || echo /usr/bin/curl)}"
SUDO="${SUDO_BIN:-$(command -v sudo 2>/dev/null || echo /usr/bin/sudo)}"

AGENT_ENV="$CTX_AGENT_DIR/.env"
env_get() { [ -f "$AGENT_ENV" ] && sed -n "s/^$1=//p" "$AGENT_ENV" | head -1 | tr -d '"'; }
CHAT_ID="${WATCHDOG_CHAT_ID:-$(env_get CHAT_ID)}"
THREAD_ID="${WATCHDOG_THREAD_ID:-$(env_get TOPIC_ID)}"
BOT_TOKEN_FALLBACK="$(env_get BOT_TOKEN)"

# Identical send path to trigger-watchdog: bus CLI first, raw-curl 0600-config fallback,
# TELEGRAM_API_BASE override so tests can make a send structurally impossible.
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
    local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/dwd-XXXXXX")" || return 1
    chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
    {
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

# --- deterministic readings ---
# root use% (integer). df is always readable (no perms). Fixture overrides for tests.
disk_pct() {
  if [ -n "$DF_FIXTURE" ]; then printf '%s' "$DF_FIXTURE"; return; fi
  df -P "$MOUNT" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}'
}
# largest single file under SCAN_DIR as "<bytes> <path>" (best-effort; sudo -n if available so
# root-owned 640 logs like auth.log are visible; tolerates perm errors — df% still pages if this
# can't read). Fixture overrides for tests.
biggest_logfile() {
  if [ -n "$LOGSIZE_FIXTURE" ]; then printf '%s' "$LOGSIZE_FIXTURE"; return; fi
  local finder=(find "$SCAN_DIR" -xdev -type f -printf '%s %p\n')
  if [ -x "$SUDO" ] && "$SUDO" -n true 2>/dev/null; then
    "$SUDO" -n "${finder[@]}" 2>/dev/null | sort -rn | head -1
  else
    "${finder[@]}" 2>/dev/null | sort -rn | head -1
  fi
}

# Test seam: source with DISK_WATCHDOG_LIB_ONLY=1 to load funcs without running the monitor.
if [ "${DISK_WATCHDOG_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# Serialize the state machine: a non-blocking flock so two overlapping cron runs can't race the
# pending counter / marker (double-send or a lost debounce increment). If a run is already
# holding it, skip this tick (the next one covers it). flock is optional — degrade if absent.
# Only engage the lock when flock exists AND the lock file opens — if the lock can't be opened
# we run UNLOCKED (degrade) rather than mislabel it as contention and skip a real tick.
if command -v flock >/dev/null 2>&1 && exec 9>"$STATE_DIR/.lock" 2>/dev/null; then
  flock -n 9 || { log "another disk-watchdog run holds the lock — skipping this tick"; exit 0; }
fi

PCT="$(disk_pct)"
case "$PCT" in ''|*[!0-9]*) log "FATAL: could not read a numeric df use% for $MOUNT (got '$PCT')"; exit 0 ;; esac
BIG="$(biggest_logfile)"; BIG_BYTES="${BIG%% *}"; BIG_PATH="${BIG#* }"
# Coerce a missing/empty/non-numeric size to 0 so the runaway check degrades to df-only
# gracefully — find can return nothing (empty or perm-denied SCAN_DIR) and must never error the
# integer comparison below. (An empty string passes the all-digits test, so check it explicitly.)
case "$BIG_BYTES" in ''|*[!0-9]*) BIG_BYTES=0; BIG_PATH="none" ;; esac
RUNAWAY_BYTES=$(( RUNAWAY_GB * 1024 * 1024 * 1024 ))
BIG_GB=$(( BIG_BYTES / 1024 / 1024 / 1024 ))

REASONS=()
[ "$PCT" -ge "$PAGE_PCT" ] && REASONS+=("root ${MOUNT} at ${PCT}% (>= ${PAGE_PCT}%)")
if [ "$BIG_BYTES" -ge "$RUNAWAY_BYTES" ]; then REASONS+=("runaway file ${BIG_PATH} = ${BIG_GB}G (>= ${RUNAWAY_GB}G)"); fi
TRIGGERED=0; [ "${#REASONS[@]}" -gt 0 ] && TRIGGERED=1

log "check: ${MOUNT}=${PCT}% biggest=${BIG_GB}G(${BIG_PATH:-none}) decision=$([ "$TRIGGERED" = 1 ] && echo PAGE || echo OK)"
[ "$DRY_RUN" = "1" ] && echo "DECISION=$([ "$TRIGGERED" = 1 ] && echo PAGE || echo OK) pct=$PCT biggest=${BIG_GB}G:${BIG_PATH:-none} reasons=[${REASONS[*]:-}]"

PEND="$STATE_DIR/pending"; MARK="$STATE_DIR/incident.json"
if [ "$TRIGGERED" = 1 ]; then
  if [ -f "$MARK" ]; then
    log "disk incident ongoing (already alerted)"
  else
    cnt=0; [ -f "$PEND" ] && cnt="$(cat "$PEND" 2>/dev/null || echo 0)"; cnt=$((cnt+1))
    [ "$DRY_RUN" = "1" ] || echo "$cnt" > "$PEND"
    if [ "$cnt" -ge 2 ]; then
      msg="$(printf '🔴 Solo DISK alert: %s. Free space now or the host wedges (it filled to 100%% on 6/30). Fix a runaway log with: sudo truncate -s 0 <file> + restart the writer. Watchdog reports recovery.' "$(IFS='; '; echo "${REASONS[*]}")")"
      if send_alert "$msg"; then
        [ "$DRY_RUN" = "1" ] || { mt="$(mktemp "$STATE_DIR/.m-XXXXXX")"; printf '{"since":"%s","pct":%s}' "$(ts)" "$PCT" > "$mt" && mv -f "$mt" "$MARK"; rm -f "$PEND"; }
      fi
    else
      log "disk trigger cycle $cnt/2 — debouncing"
    fi
  fi
else
  [ "$DRY_RUN" = "1" ] || rm -f "$PEND"
  if [ -f "$MARK" ] && [ "$PCT" -lt "$WARN_PCT" ]; then
    if send_alert "🟢 Solo disk RECOVERED: ${MOUNT} back to ${PCT}% (< ${WARN_PCT}%), no runaway log. "; then
      [ "$DRY_RUN" = "1" ] || rm -f "$MARK"; log "recovery sent (${PCT}%)"
    else
      log "recovery send FAILED — keeping marker, retry next tick"
    fi
  elif [ "$PCT" -ge "$WARN_PCT" ]; then
    log "WARN: ${MOUNT} at ${PCT}% (>= ${WARN_PCT}% warn, < ${PAGE_PCT}% page) — watching"
  fi
fi
exit 0
