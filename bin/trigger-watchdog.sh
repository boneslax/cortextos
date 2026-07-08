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
# ALERT SEND-PATH (send_alert) — 3 tiers, each a fallback for the one before:
#   tier 1  bus CLI (cortextos bus send-telegram)         — DNS-dependent
#   tier 2  raw-curl to ${TELEGRAM_API_BASE}/bot.../sendMessage — DNS-dependent
#   tier 3  DNS-BYPASS raw-curl: same send, but pinned to a cached last-good IP via
#           `curl --resolve <host>:443:<cachedIP>` so NO resolver is consulted. Closes the
#           2026-07-07 blind spot where a link-up-but-DNS-flaky window (a flapping WiFi NIC)
#           took DNS + BOTH send tiers down together, so a BLIND-RISK/prod-stall alert fired
#           but could NOT be delivered — the alert rode the very resolver that was broken.
#     - The cached IP is ONLY a ROUTING HINT; the api.telegram.org TLS cert is the IDENTITY
#       guarantee and stays FULLY validated — NEVER -k/--insecure. A stale/rotated IP that now
#       fronts a different host → cert mismatch → TLS fails → the send fails CLOSED and falls
#       through, so tier 3 can NEVER mis-deliver an alert to a wrong host.
#     - On each SUCCESSFUL tier-1/tier-2 send, the current api.telegram.org IP is resolved and
#       written 0600+atomic to $STATE_DIR/telegram-api-ip.cache (a successful send means DNS is
#       healthy this tick) — a self-updating last-good IP. Cold cache (no prior success) → tier 3
#       can't fire → the delivery failure is logged LOUDLY, never swallowed.
#     - The cached value is format-validated against a strict single-IP-literal regex before it is
#       ever fed to curl (anti corrupt-cache/injection); a bad value skips tier 3 and logs loud.
#   This covers "Mode 1" (link up, DNS flaky). "Mode 2" (Solo totally dark, no route at all) is
#   uncoverable by ANY local send — the backstop is the EXTERNAL vault-memory-health heartbeat:
#   when Solo's 30-min heartbeat POSTs STOP, checkVaultMemoryHealth() (src/lib/watchdog-checks.ts)
#   fires a cloud-side (Trigger.dev→Teams) critical alert on heartbeat ABSENCE. See [[watchdog-resilience]].
#
# Tunables (env):
#   WATCHDOG_STALL_MIN     minutes: a project is STALLED when nothing has COMPLETED in this
#                          window AND there's 0 executing + a queued backlog (default 10)
#   WATCHDOG_MIN_QUEUED    queued count that counts as a backlog (default 1)
#   WATCHDOG_KEY_STALE_ALERT_SEC   BLIND-RISK self-alert floor: seconds since the last SUCCESSFUL
#                          op key-refresh (oldest keycache mtime) before the watchdog pages that
#                          it's going blind (default 10800 = 3h; a FIXED floor well under any
#                          plausible read-key rotation, and > KEY_TTL so a normal refresh never trips it)
#   WATCHDOG_KEY_STALE_REALERT_SEC re-alert BLIND-RISK at most once per this many seconds while
#                          degraded (default 21600 = 6h); marker cleared when the read-path recovers
#   WATCHDOG_KEY_MISSING_GRACE_SEC grace for a MISSING (not just stale) keycache file: it must stay
#                          missing this long before counting as blind, so a routine key rotation
#                          (401 → bust → re-fetch next tick) never false-fires (default 1800 = 30m).
#                          A PRESENT-but-stale cache is UNAFFECTED — it still fires at the 3h floor.
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
KEYCACHE_DIR="$STATE_DIR/keycache"      # 0600 cached read keys (avoid op-per-tick rate limit)
KEY_TTL="${WATCHDOG_KEY_TTL:-3600}"     # seconds before a cached key is refreshed from op
KEY_STALE_ALERT_SEC="${WATCHDOG_KEY_STALE_ALERT_SEC:-10800}"    # blind-risk self-alert floor (3h; validated below)
KEY_STALE_REALERT_SEC="${WATCHDOG_KEY_STALE_REALERT_SEC:-21600}" # re-alert cadence while degraded (6h; validated below)
KEY_MISSING_GRACE_SEC="${WATCHDOG_KEY_MISSING_GRACE_SEC:-1800}"  # a MISSING cache must persist this long before it counts as blind (30m; validated below)
HTTP_CODE_FILE="$STATE_DIR/.lasthttp.$$" # fetch_runs writes the HTTP status here (survives
                                        # command-substitution subshells so the loop can read it);
                                        # per-PID so overlapping runs can't clobber each other's code
mkdir -p "$STATE_DIR"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Validate numeric tunables — a typo'd env must NOT silently disable the blind-risk self-alert
# (a non-numeric threshold breaks the `-ge`/`-lt` compares → the watchdog stops watching itself)
# nor break arithmetic under set -u. Fall back to the documented default. (Mirrors disk-watchdog.sh.)
numdef() {
  case "$2" in
    ''|*[!0-9]*) log "WARN: $1='$2' is not a positive integer — using default $3"; printf '%s' "$3"; return ;;
  esac
  if [ "$2" -gt 0 ]; then printf '%s' "$2"; else log "WARN: $1='$2' must be > 0 — using default $3"; printf '%s' "$3"; fi
}
KEY_STALE_ALERT_SEC="$(numdef WATCHDOG_KEY_STALE_ALERT_SEC "$KEY_STALE_ALERT_SEC" 10800)"
KEY_STALE_REALERT_SEC="$(numdef WATCHDOG_KEY_STALE_REALERT_SEC "$KEY_STALE_REALERT_SEC" 21600)"
KEY_MISSING_GRACE_SEC="$(numdef WATCHDOG_KEY_MISSING_GRACE_SEC "$KEY_MISSING_GRACE_SEC" 1800)"

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

GETENT="${GETENT_BIN:-$(command -v getent 2>/dev/null || echo /usr/bin/getent)}"
TIMEOUT="${TIMEOUT_BIN:-$(command -v timeout 2>/dev/null || echo /usr/bin/timeout)}"
RESOLVE_TIMEOUT="${WATCHDOG_RESOLVE_TIMEOUT:-3}"   # hard cap (sec) on the cache-warm resolve (never block a tick)

# Derive the Telegram API HOST from TELEGRAM_API_BASE (default real). ONE source of truth shared by
# tier-2/tier-3's curl config, the cache-write resolve, AND the per-tick cache warm — so the tier-3
# `--resolve` host can NEVER drift from the host the cache is warmed/read for. Drift would break both
# tier-3 routing AND test isolation (a test's dead base must neutralize EVERY path, tick-warm included).
telegram_api_host() {
  local b="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  b="${b#*://}"; b="${b%%/*}"; b="${b%%:*}"; printf '%s' "$b"
}

# Strict single-IP-literal validator — ONE IPv4 dotted-quad (octets 0-255) OR one IPv6
# hex:colon literal, and NOTHING else: no newlines, no spaces, no extra tokens, no comments,
# no shell/curl-config metacharacters. Used BOTH before writing telegram-api-ip.cache AND before
# feeding a cached value to `curl --resolve` (anti corrupt-cache / anti injection). A value that
# does not pass this MUST NEVER reach curl. (The cache read strips a trailing newline via command
# substitution; an INTERNAL newline / multi-line file trips the charset reject below.)
valid_ip_literal() {
  local ip="$1"
  # fast reject: empty, or any char outside the IP-literal alphabet (catches spaces, newlines,
  # ';', '"', backslashes, '=', etc. — so a corrupt/tampered cache can never inject curl-config).
  case "$ip" in
    ''|*[!0-9a-fA-F:.]*) return 1 ;;
  esac
  # exactly one IPv4 dotted-quad, each octet 0-255
  if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    local o1 o2 o3 o4
    IFS=. read -r o1 o2 o3 o4 <<< "$ip"
    [ "$o1" -le 255 ] && [ "$o2" -le 255 ] && [ "$o3" -le 255 ] && [ "$o4" -le 255 ]
    return
  fi
  # one IPv6 literal (hex + colons; must contain at least one colon). Not exhaustively RFC-valid,
  # but metacharacter-free so it can't inject; curl rejects a truly malformed one → fail closed.
  if [[ "$ip" == *:* ]] && [[ "$ip" =~ ^[0-9a-fA-F:]+$ ]]; then return 0; fi
  return 1
}

# BEST-EFFORT cache write: resolve the Telegram API host's current IP and store it 0600+atomic in
# $STATE_DIR/telegram-api-ip.cache as a self-updating last-good DNS-bypass hint for tier 3. Called on
# BOTH (1) a successful tier-1/tier-2 send (DNS is healthy that tick → captures a known-good IP) and
# (2) every healthy monitor tick (preheat, so the FIRST alert of an incident is protected even if it
# lands during a DNS flap). Host derives from TELEGRAM_API_BASE (same knob as tiers 2+3) so a test
# pointing it at a dead base stays fully isolated. Best-effort — always returns 0, so a failed cache
# write can NEVER undo an already-delivered alert nor affect a tick.
#
# TWO hardening invariants (both send + tick paths inherit them, since both call this one function):
#   * TIMEOUT-BOUND the resolve — a flaky/hung resolver must not make this hang. `timeout` caps the
#     getent at RESOLVE_TIMEOUT sec; on timeout/failure the resolve yields empty → the write is SKIPPED.
#   * ONLY-WRITE-ON-SUCCESS — validate FIRST, then write via temp + atomic mv. A failed/empty/timed-out
#     resolve or a non-IP result leaves the existing last-good cache UNTOUCHED (the real file is never
#     opened for truncation), so a flap can NEVER clobber/empty the very last-good IP tier-3 needs then.
cache_telegram_ip() {
  local host="$1" ip cf t
  [ -n "$host" ] || return 0
  # TIMEOUT-BOUND resolve (first A record). If `timeout` is unavailable, fall back to a bare resolve.
  if command -v "$TIMEOUT" >/dev/null 2>&1; then
    ip="$("$TIMEOUT" "$RESOLVE_TIMEOUT" "$GETENT" ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
  else
    ip="$("$GETENT" ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
  fi
  # ONLY-WRITE-ON-SUCCESS: bail (leaving last-good intact) on an empty/timed-out or non-IP resolve.
  [ -n "$ip" ] || return 0
  valid_ip_literal "$ip" || return 0
  cf="$STATE_DIR/telegram-api-ip.cache"
  t="$(mktemp "$STATE_DIR/.tgip-XXXXXX" 2>/dev/null)" || return 0
  printf '%s' "$ip" > "$t" 2>/dev/null && chmod 600 "$t" 2>/dev/null && mv -f "$t" "$cf" 2>/dev/null
  rm -f "$t" 2>/dev/null
  return 0
}

send_alert() {
  local msg="$1"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN alert: $msg"; return 0; fi

  # ONE knob drives tiers 2 AND 3 (and the cache-resolve): the API base + its derived host. Tests
  # point TELEGRAM_API_BASE at a dead endpoint to make EVERY send structurally impossible — incl.
  # tier 3, because the `--resolve <api_host>:443:...` directive only takes effect for the API host
  # on 443, and against a dead base (different host/port) it is a no-op. NEVER hardcode
  # api.telegram.org below, or a test could escape isolation and hit the real Telegram API.
  local api_base api_host
  api_base="${TELEGRAM_API_BASE:-https://api.telegram.org}"
  api_host="$(telegram_api_host)"   # SAME derivation the tick-warm uses — can't drift

  # ---- tier 1: bus CLI (DNS-dependent) ----
  local args=("$CHAT_ID" "$msg" --plain-text)
  [ -n "$THREAD_ID" ] && args+=(--thread "$THREAD_ID")
  if [ -x "$CORTEXTOS" ] && "$CORTEXTOS" bus send-telegram "${args[@]}" >/dev/null 2>&1; then
    log "alert sent via bus CLI"; cache_telegram_ip "$api_host"; return 0
  fi

  log "bus CLI send failed — raw-curl Telegram fallback"
  # ---- tier 2: raw-curl (DNS-dependent) ----
  if [ -n "$BOT_TOKEN_FALLBACK" ]; then
    local cfg; cfg="$(mktemp "${TMPDIR:-/tmp}/twd-XXXXXX")" || return 1
    chmod 600 "$cfg"; trap 'rm -f "$cfg"' RETURN
    {
      # TELEGRAM_API_BASE override (default real) lets tests point the raw-curl
      # fallback at a dead endpoint so a send is structurally impossible.
      printf 'url = "%s/bot%s/sendMessage"\n' "$api_base" "$BOT_TOKEN_FALLBACK"
      printf 'data-urlencode = "chat_id=%s"\n' "$CHAT_ID"
      printf 'data-urlencode = "text=%s"\n' "$msg"
      [ -n "$THREAD_ID" ] && printf 'data-urlencode = "message_thread_id=%s"\n' "$THREAD_ID"
      printf 'max-time = 15\nsilent\nshow-error\nfail\n'
    } > "$cfg"
    local ok=1; "$CURL" --config "$cfg" >/dev/null 2>&1 && ok=0; rm -f "$cfg"
    [ "$ok" = 0 ] && { log "alert sent via raw-curl fallback"; cache_telegram_ip "$api_host"; return 0; }
  fi

  # ---- tier 3: DNS-BYPASS via cached last-good IP (closes Mode 1: link up, resolver flaky) ----
  # Tiers 1+2 both failed — the resolver is likely misbehaving. Retry the SAME send pinned to the
  # cached last-good IP via `curl --resolve <host>:443:<ip>`, so NO DNS lookup is needed. The cached
  # IP is ONLY a ROUTING HINT; the api.telegram.org TLS certificate stays FULLY validated and is the
  # IDENTITY guarantee. NEVER -k/--insecure here: a stale/rotated IP now fronting a different host →
  # cert mismatch → TLS handshake fails → the send fails CLOSED and falls through, so an alert can
  # NEVER be mis-delivered to the wrong host. A stale-IP TLS failure is CORRECT fail-closed behavior.
  local cache="$STATE_DIR/telegram-api-ip.cache"
  if [ -n "$BOT_TOKEN_FALLBACK" ] && [ -f "$cache" ]; then
    local cip; cip="$(cat "$cache" 2>/dev/null)"   # command-sub strips a trailing newline
    if valid_ip_literal "$cip"; then
      local raddr="$cip"; case "$cip" in *:*) raddr="[$cip]" ;; esac   # bracket IPv6 for --resolve
      local cfg3; cfg3="$(mktemp "${TMPDIR:-/tmp}/twd3-XXXXXX")" || return 1
      chmod 600 "$cfg3"; trap 'rm -f "$cfg3"' RETURN
      {
        printf 'url = "%s/bot%s/sendMessage"\n' "$api_base" "$BOT_TOKEN_FALLBACK"
        # Pin the route to the cached IP on 443 while keeping SNI/Host/cert validation for api_host.
        # NO `insecure` line — TLS identity is enforced; a wrong IP fails the handshake (fail closed).
        printf 'resolve = "%s:443:%s"\n' "$api_host" "$raddr"
        printf 'data-urlencode = "chat_id=%s"\n' "$CHAT_ID"
        printf 'data-urlencode = "text=%s"\n' "$msg"
        [ -n "$THREAD_ID" ] && printf 'data-urlencode = "message_thread_id=%s"\n' "$THREAD_ID"
        printf 'max-time = 15\nsilent\nshow-error\nfail\n'
      } > "$cfg3"
      local ok3=1; "$CURL" --config "$cfg3" >/dev/null 2>&1 && ok3=0; rm -f "$cfg3"
      [ "$ok3" = 0 ] && { log "alert sent via tier-3 DNS-bypass (cached IP, TLS-validated)"; return 0; }
      log "tier-3 DNS-bypass send FAILED (cached IP $cip — cert mismatch fails CLOSED, or still no route)"
    else
      log "ALERT DELIVERY FAILED — cached Telegram IP failed format validation (corrupt cache; tier-3 skipped, nothing fed to curl)"
    fi
  fi

  # ---- all tiers exhausted — degrade LOUD, never silent ----
  if [ ! -f "$cache" ]; then
    log "ALERT DELIVERY FAILED (both bus CLI and raw curl; no cached IP — tier-3 DNS-bypass cold, cannot fire)"
  else
    log "ALERT DELIVERY FAILED (bus CLI, raw curl, and tier-3 DNS-bypass all failed)"
  fi
  return 1
}

age_secs() { # iso8601 -> seconds ago (echo big number if empty/unparseable)
  local iso="$1"; [ -z "$iso" ] || [ "$iso" = "null" ] && { echo 999999999; return; }
  local e; e="$(date -u -d "$iso" +%s 2>/dev/null)" || { echo 999999999; return; }
  echo $(( $(date -u +%s) - e ))
}

# Fetch a project's runs for a status. Honors WATCHDOG_RUNS_FIXTURE_<LABEL>_<STATUS>
# (a file path) for tests so no key/network is needed.
LAST_HTTP_CODE=""   # set by fetch_runs; the project loop busts the key cache on 401/403
# Record an HTTP status to HTTP_CODE_FILE, but let an auth failure (401/403) STICK across the
# three per-project fetches — a later 200 (COMPLETED) must not erase a 401 seen on an earlier
# status query (EXECUTING/QUEUED), or the key-rotation bust would be missed.
record_http_code() {
  grep -qE '^(401|403)$' "$HTTP_CODE_FILE" 2>/dev/null && return 0
  printf '%s' "$1" > "$HTTP_CODE_FILE" 2>/dev/null && chmod 600 "$HTTP_CODE_FILE" 2>/dev/null
}
fetch_runs() {
  local label="$1" key="$2" status="$3"
  LAST_HTTP_CODE=""
  local varname="WATCHDOG_RUNS_FIXTURE_${label}_${status}" fix=""   # indirect, no eval
  [ -n "${!varname:+x}" ] && fix="${!varname}"                       # (:- form trips some bash; :+ is safe)
  if [ -n "$fix" ]; then LAST_HTTP_CODE=200; record_http_code 200; cat "$fix" 2>/dev/null; return 0; fi
  local cfg body; cfg="$(mktemp "${TMPDIR:-/tmp}/twr-XXXXXX")" || return 1
  body="$(mktemp "${TMPDIR:-/tmp}/twb-XXXXXX")" || { rm -f "$cfg"; return 1; }
  chmod 600 "$cfg"; trap 'rm -f "$cfg" "$body"' RETURN
  {
    printf 'url = "https://api.trigger.dev/api/v1/runs?filter[status]=%s&page[size]=20"\n' "$status"
    printf 'header = "Authorization: Bearer %s"\n' "$key"
    # No `fail` — we want the body+status even on an HTTP error so we can detect 401/403.
    printf 'globoff\nmax-time = 20\nsilent\noutput = "%s"\nwrite-out = "%%{http_code}"\n' "$body"
  } > "$cfg"
  chmod 600 "$body" 2>/dev/null
  LAST_HTTP_CODE="$("$CURL" --config "$cfg" 2>/dev/null)"
  # fetch_runs usually runs inside a command substitution, so a bare global wouldn't reach the
  # caller — persist the code to a file the parent loop reads after project_check returns (401-sticky).
  record_http_code "$LAST_HTTP_CODE"
  cat "$body" 2>/dev/null
  rm -f "$cfg" "$body"
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
  : > "$HTTP_CODE_FILE" 2>/dev/null   # reset per project so a prior label's 401 doesn't leak in
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

# Drop a key's cache so the next run re-fetches from op (called on a runs-API 401/403 =
# the key may have rotated).
bust_key_cache() { rm -f "$KEYCACHE_DIR/$1.key" 2>/dev/null; }

# Resolve a project read key, CACHED. Calling `op item get` every 3-min tick (2/run, ~40/hr)
# tripped the 1Password SA rate limit and blinded the watchdog. So: serve a fresh cached key
# (age < KEY_TTL) WITHOUT touching op; only call op when the cache is missing/stale; and on ANY
# op failure (throttle/rate-limit) fall back to the LAST-GOOD cached key — stale-but-present beats
# blind. Cache files are 0600. Returns "" only when op fails AND there's no cache at all.
get_key() {
  local field="$1"
  local cache="$KEYCACHE_DIR/$field.key" cached="" age=99999999 mt now
  if [ -f "$cache" ]; then
    cached="$(cat "$cache" 2>/dev/null)"
    mt="$(stat -c %Y "$cache" 2>/dev/null || echo 0)"; now="$(date -u +%s)"; age=$(( now - mt ))
  fi
  # Fresh cache hit — reuse, no op call.
  if [ -n "$cached" ] && [ "$age" -lt "$KEY_TTL" ]; then echo "$cached"; return; fi
  # Stale/missing — try op.
  local fresh="" rc=1
  if [ -f "$OP_SA_TOKEN_FILE" ]; then
    fresh="$(OP_SERVICE_ACCOUNT_TOKEN="$(cat "$OP_SA_TOKEN_FILE")" "$OP" --vault="PKM Automation" \
      item get "$OP_ITEM" --fields "$field" --reveal 2>/dev/null)"; rc=$?
  fi
  # Only trust op output when op actually SUCCEEDED — a nonzero exit that still printed to stdout
  # (a wrapper, a future CLI quirk) must not poison the cache.
  [ "$rc" -ne 0 ] && fresh=""
  if [ -n "$fresh" ]; then
    mkdir -p "$KEYCACHE_DIR" 2>/dev/null; chmod 700 "$KEYCACHE_DIR" 2>/dev/null
    local t; t="$(mktemp "$KEYCACHE_DIR/.k-XXXXXX" 2>/dev/null)" \
      && printf '%s' "$fresh" > "$t" && chmod 600 "$t" && mv -f "$t" "$cache"
    echo "$fresh"; return
  fi
  # op failed (rate-limit/throttle/missing token). Don't go blind — serve last-good if we have it.
  if [ -n "$cached" ]; then
    log "[keycache] op fetch failed for $field — using last-good cached key (age ${age}s)"
    echo "$cached"; return
  fi
  log "[keycache] op fetch failed for $field + no cache — key unavailable"
  echo ""
}

# ---- watcher-unwatched: BLIND-RISK self-alert on a stale read-key refresh ----
# The gap this closes (2026-07-07): the watchdog can go BLIND for hours — op key-refresh
# failing → get_key serves a last-good STALE cached key → every Trigger read reads UNKNOWN
# (or 401s once the key rotates) — while the watchdog says NOTHING. A real prod stall in that
# window would be missed silently. So the watchdog now watches ITS OWN read path.
#
# Signal = the OLDEST keycache-file mtime across the configured read-key fields. get_key writes
# the cache ONLY on a SUCCESSFUL op-fetch (and a fresh hit never rewrites it), so the mtime IS
# the time of the last successful refresh. A configured key whose cache file is MISSING entirely
# (never fetched, or busted-with-no-refetch) = maximally stale. Healthy op keeps the mtime within
# KEY_TTL (1h); a failing op freezes it → it ages past the floor → we page.
#
# ALERT-BEFORE-BLIND: fire while the cached key is still likely VALID, to give LEAD TIME to fix
# the op-fetch before a key rotation 401s it. So the threshold is a FIXED FLOOR (default 3h) —
# well under any plausible read-key rotation and > KEY_TTL so a normal refresh never trips it —
# NOT the (unpredictable) rotation interval, which would only alert once already blind.
#
# This is INDEPENDENT of the per-project prod-stall page and runs every tick. Its message is
# DISTINCT (a monitoring-gap warning, "NOT a prod-stall page") and rate-limited via a STATE_DIR
# marker to at most once per KEY_STALE_REALERT_SEC while degraded; the marker is CLEARED on
# recovery (oldest cache fresh again) so a future degradation re-alerts. Echoes a KEYSTALE_DECISION
# line under DRY_RUN (like the prod-stall DECISION) for unit tests; always logs its decision.
check_key_refresh_staleness() {
  local marker="$STATE_DIR/keystale-alerted.marker"
  local now oldest_age=-1 spec field cache mt age missmark missing_for smt
  now="$(date -u +%s)"
  for spec in "${PROJECTS[@]}"; do
    field="${spec##*:}"                 # label:projref:field -> field
    cache="$KEYCACHE_DIR/$field.key"
    missmark="$STATE_DIR/keymissing.$field.since"
    if [ -f "$cache" ]; then
      # Present — a successful (re)fetch this-or-a-prior tick. Clear any missing-since marker so a
      # transient rotation-bust that self-heals never accrues toward the blind threshold; the age
      # is just the mtime staleness (the ORIGINAL, unchanged present-but-stale path).
      [ "$DRY_RUN" = "1" ] || rm -f "$missmark" 2>/dev/null
      mt="$(stat -c %Y "$cache" 2>/dev/null || echo 0)"; age=$(( now - mt ))
    else
      # MISSING — apply a GRACE so a routine key rotation (401 → bust deletes the cache mid-loop →
      # re-fetch repopulates it next tick) never false-fires. A missing cache counts as blind ONLY
      # after it has stayed missing longer than KEY_MISSING_GRACE_SEC (a persistent op-fetch failure),
      # tracked by a first-seen-missing marker (its mtime = when the cache first went missing).
      missing_for=0
      if [ -f "$missmark" ]; then
        smt="$(stat -c %Y "$missmark" 2>/dev/null || echo "$now")"; missing_for=$(( now - smt ))
      else
        [ "$DRY_RUN" = "1" ] || { : > "$missmark" 2>/dev/null && chmod 600 "$missmark" 2>/dev/null; }
      fi
      if [ "$missing_for" -gt "$KEY_MISSING_GRACE_SEC" ]; then
        age=999999999                   # persistently missing beyond grace = fully blind
      else
        age=0                           # within grace — a transient bust; treat as fresh (don't fire)
      fi
    fi
    [ "$age" -gt "$oldest_age" ] && oldest_age="$age"
  done
  # Human-friendly age for the message; a never-refreshed (missing/sentinel) key isn't "277777h".
  local agelabel; if [ "$oldest_age" -ge 315360000 ]; then agelabel="never-refreshed"; else agelabel="$(( oldest_age / 3600 ))h"; fi

  if [ "$oldest_age" -ge "$KEY_STALE_ALERT_SEC" ]; then
    # Degraded. Rate-limit: alert at most once per KEY_STALE_REALERT_SEC (marker mtime = last alert).
    local last_alert_age=999999999 mmt
    if [ -f "$marker" ]; then mmt="$(stat -c %Y "$marker" 2>/dev/null || echo 0)"; last_alert_age=$(( now - mmt )); fi
    if [ -f "$marker" ] && [ "$last_alert_age" -lt "$KEY_STALE_REALERT_SEC" ]; then
      log "[keystale] read-path stale ${oldest_age}s (>= ${KEY_STALE_ALERT_SEC}s) — re-alert suppressed (last ${last_alert_age}s ago < ${KEY_STALE_REALERT_SEC}s)"
      [ "$DRY_RUN" = "1" ] && echo "KEYSTALE_DECISION=SUPPRESSED ageSec=$oldest_age thresholdSec=$KEY_STALE_ALERT_SEC"
      return 0
    fi
    [ "$DRY_RUN" = "1" ] && echo "KEYSTALE_DECISION=ALERT ageSec=$oldest_age thresholdSec=$KEY_STALE_ALERT_SEC"
    if send_alert "$(printf '⚠️ WATCHDOG BLIND-RISK: Trigger read-path stale %s (op key-refresh failing) — prod visibility degrading, fix the op-fetch before a key rotation blinds it. This is NOT a prod-stall page.' "$agelabel")"; then
      [ "$DRY_RUN" = "1" ] || { : > "$marker" 2>/dev/null && chmod 600 "$marker" 2>/dev/null; }
      log "[keystale] BLIND-RISK alert fired (read-path stale ${oldest_age}s, oldest keycache mtime)"
    else
      log "[keystale] BLIND-RISK alert send FAILED — will retry next tick"
    fi
    return 0
  fi

  # Fresh — read path healthy (or recovered). If a BLIND-RISK was actually alerted (the rate-limit
  # marker exists), announce the resolution ONCE — symmetric with the prod-stall recovery message —
  # then clear the marker. The clear is UNCONDITIONAL (independent of whether this recovery send
  # succeeds): the marker is the loop condition, so clearing it guarantees at most one recovery send.
  # A never-degraded steady state has no marker and stays SILENT.
  if [ -f "$marker" ]; then
    send_alert "🟢 WATCHDOG read-path RECOVERED — Trigger key refresh healthy again (oldest cache $(( oldest_age / 60 ))m < $(( KEY_STALE_ALERT_SEC / 60 ))m). Blind-risk cleared." || true
    [ "$DRY_RUN" = "1" ] || rm -f "$marker" 2>/dev/null
    log "[keystale] read-path RECOVERED (oldest keycache ${oldest_age}s < ${KEY_STALE_ALERT_SEC}s) — sent recovery + cleared blind-risk marker"
    [ "$DRY_RUN" = "1" ] && echo "KEYSTALE_DECISION=RECOVERED ageSec=$oldest_age thresholdSec=$KEY_STALE_ALERT_SEC"
    return 0
  fi
  log "[keystale] read-path fresh (oldest keycache ${oldest_age}s < ${KEY_STALE_ALERT_SEC}s)"
  [ "$DRY_RUN" = "1" ] && echo "KEYSTALE_DECISION=OK ageSec=$oldest_age thresholdSec=$KEY_STALE_ALERT_SEC"
  return 0
}

# Test seam: sourcing with WATCHDOG_LIB_ONLY=1 loads the functions (get_key, fetch_runs,
# bust_key_cache, check_key_refresh_staleness, …) WITHOUT running the monitor, so they can be
# unit-tested in isolation.
if [ "${WATCHDOG_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ---- PREHEAT the tier-3 DNS-bypass cache (every healthy tick, BEFORE any alert can fire) ----
# On-successful-send warming alone can't protect the FIRST alert of a NEW incident if it lands during
# a DNS-flaky window (no prior send this incident → cold cache → tier-3 can't fire) — and that first
# stall/blind-risk page is the highest-value message a live watchdog sends. So preheat the cache on
# every normal tick while DNS is healthy. It is TRULY FREE and CAN'T HARM THE TICK:
#   * BACKGROUNDED (&) — the tick's real work (status fetch + stall check + blind-risk self-alert)
#     proceeds immediately and is NEVER blocked/delayed, even if the resolver hangs during a flap.
#   * TIMEOUT-BOUND inside cache_telegram_ip (RESOLVE_TIMEOUT, default 3s) — a hung resolve self-reaps
#     instead of lingering as an orphan.
#   * ONLY-WRITES-ON-SUCCESS — a failed/empty/timed-out resolve leaves the last-good cache UNTOUCHED,
#     so a flap can never clobber the very last-good IP tier-3 depends on during that flap.
# Host derives from TELEGRAM_API_BASE via the SAME helper tier-3 uses, so a test's dead base resolves a
# harmless test host into the temp state dir — never the real API (isolation preserved). Skipped under
# DRY_RUN (the file's state-write convention). Runs ONLY on the real-run path, never under LIB_ONLY.
if [ "$DRY_RUN" != "1" ]; then
  cache_telegram_ip "$(telegram_api_host)" >/dev/null 2>&1 &
fi

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
  fixvar="WATCHDOG_RUNS_FIXTURE_${label}_EXECUTING"; fixset=""   # guarded indirect, no eval
  [ -n "${!fixvar:+x}" ] && fixset="${!fixvar}"
  if [ -n "$fixset" ]; then key="FIXTURE"; else key="$(get_key "$field")"; fi
  if [ -z "$key" ]; then
    log "[$label] no read key (1Password $field) — impact-check unavailable; NOT paging"
    CONTEXT_LINES="$CONTEXT_LINES\n$label: key-unavailable"
    continue
  fi
  res="$(project_check "$label" "$key")"
  # Auth failure on the runs API => the cached key may have rotated. Bust it so the next
  # run re-fetches from op (don't keep serving a dead key from cache). The code comes from
  # HTTP_CODE_FILE because project_check/fetch_runs ran in subshells (a global wouldn't survive).
  http_code="$(cat "$HTTP_CODE_FILE" 2>/dev/null || echo)"
  case "$http_code" in
    401|403) [ "$key" != "FIXTURE" ] && { bust_key_cache "$field"; log "[$label] runs API $http_code — busted key cache (rotated?)"; } ;;
  esac
  log "[$label] $res ($STATUS_CTX)"
  CONTEXT_LINES="$CONTEXT_LINES\n$label: $res"
  [ "${res%% *}" = "STALL" ] && STALLED_NOW+=("$label")
done

# ---- watcher-unwatched: BLIND-RISK self-alert (runs EVERY tick, independent of the stall check) ----
# Placed AFTER the impact loop so get_key has already exercised the read path this tick — a healthy
# op refreshes the cache mtime (no false blind-risk), a failing op leaves it frozen (→ ages → pages).
check_key_refresh_staleness

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
rm -f "$HTTP_CODE_FILE" 2>/dev/null   # per-PID scratch; don't accumulate
exit 0
