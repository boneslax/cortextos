# Disk Watchdog (independent host disk-space monitor)

Deterministic system-cron monitor for Solo's host disk, born from the 2026-06-30 incident:
a `gnome-keyring-daemon` FD-leak log-spammed `/var/log/auth.log` + `syslog` to 355G and filled
root to 100% — which broke Claude's command output AND made the Trigger watchdog read UNKNOWN
(a host failure masquerading as a Trigger outage). Nothing was watching host disk.

`bin/disk-watchdog.sh` — pure shell, no npm deps, no cortextOS/LLM dependency, never spawns
Claude. Runs from the **system crontab** so it survives a full disk + a daemon/LLM outage.

## What it pages on (deterministic)
- **root-fs use% ≥ `DISK_PAGE_PCT`** (default 90), OR
- **any single `/var/log` file ≥ `RUNAWAY_GB`** (default 25) — catches one ballooning log EARLY,
  before % hits the wall (the exact 6/30 mode).

`≥2-cycle` debounce before the first page; one per-incident marker (alerts once); recovery
message when back **< `DISK_WARN_PCT`** (default 80) with no runaway file. The 90/80 gap is an
intentional hysteresis band (no flapping); 80–89 logs WARN.

## Readings
- `df -P` root use% (always readable, no perms) — integer-validated; odd/non-numeric → FATAL log + exit 0.
- biggest `/var/log` file via `find -printf` (`sudo -n` best-effort so root-owned 0640 logs are
  visible). Perm-denied / empty → coerces to 0 and **degrades to df-only** (never errors).

Numeric tunables (`DISK_PAGE_PCT`/`DISK_WARN_PCT`/`RUNAWAY_GB`) are validated; a typo falls back
to the default (never blinds the watchdog). A non-blocking `flock` serializes the state machine
against overlapping cron runs.

Alert path is identical to the Trigger watchdog: `cortextos bus send-telegram … --plain-text`,
with a raw-curl 0600-`--config` fallback (token never on argv), `TELEGRAM_API_BASE` test seam.

## Install (run on Solo, with solo)
```bash
# every 10 minutes, staggered off the Trigger watchdog
*/10 * * * * CORTEXTOS_BIN=/home/bones/.npm-global/bin/cortextos /home/bones/cortextos/bin/disk-watchdog.sh
```
Optionally allow passwordless `find` for full /var/log visibility (else it degrades to df-only):
`bones ALL=(root) NOPASSWD: /usr/bin/find /var/log *` in a sudoers drop-in.

## Tunables (env)
`DISK_PAGE_PCT` (90) · `DISK_WARN_PCT` (80) · `RUNAWAY_GB` (25) · `DISK_MOUNT` (/) ·
`DISK_SCAN_DIR` (/var/log) · `DISK_WATCHDOG_DRY_RUN=1` (classify+log, no send/state) ·
`DISK_DF_FIXTURE` / `DISK_LOGSIZE_FIXTURE` / `DISK_WATCHDOG_LIB_ONLY=1` (test seams).

## Known follow-on
A single incident marker is shared by both triggers: if a runaway-file alert's marker is still
unresolved while disk sits 80–89%, a later rise ≥90% logs "already alerted" rather than a fresh
capacity page. Acceptable for v1 (one active disk incident until recovered); per-trigger markers
are the follow-up if independent escalation is wanted.
