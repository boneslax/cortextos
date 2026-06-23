# Trigger.dev Watchdog (independent outage monitor)

Independent monitor for Trigger.dev outages, born from the 2026-06-22 us-east-1
outage that took down Hub automations AND the Trigger-based watchdog (a monitor
can't live on the infra it monitors). Runs from the **system crontab** on Solo —
NOT a cortextOS agent-prompt cron (those need the agent/LLM alive) — so it
survives both a Trigger.dev outage and the cortextOS daemon/LLM being down.

`bin/trigger-watchdog.sh` — pure shell, no npm deps, never spawns Claude.

## Layer 1a (this PR): status-page detection (no credential)
Curls `https://status.trigger.dev/index.json` (Better Stack) each run and pages
Bones on Telegram when:
- `aggregate_state == downtime`, OR
- a **CRITICAL** component (`Trigger.dev cloud`, `Trigger.dev API`) is `downtime`/`degraded`.

Non-critical components (`Realtime`, `OpenTelemetry`, `Deployments`) degraded =
context only, **no page** (avoids the false-page the 2026-06-22 live state would
have caused: Realtime down while the API was operational).

Alert path: `cortextos bus send-telegram … --plain-text`, with a **raw-curl
Telegram fallback** if the cortextOS CLI itself is broken. Dedup via a timestamped
marker (`$CTX_ROOT/state/trigger-watchdog/incident-active.json`); state is
re-derived from the status page every run; a recovery message is sent on clear.

## Install (run on Solo, with solo)
```bash
# every 3 minutes; adjust paths/agent as needed
*/3 * * * * CORTEXTOS_BIN=/usr/bin/cortextos /home/bones/cortextos/bin/trigger-watchdog.sh
```
Defaults target the Solo deployment (`CTX_ROOT=/home/bones/.cortextos/default`,
`CTX_ORG=vault`, bus agent `solo`); the alert chat + raw-curl token are read from
the `solo` agent `.env` (`CHAT_ID`/`TOPIC_ID`/`BOT_TOKEN`). Override via
`WATCHDOG_CHAT_ID` / `WATCHDOG_THREAD_ID` / `WATCHDOG_CRITICAL`. Dry-run +
fixtures: `WATCHDOG_DRY_RUN=1 TRIGGER_STATUS_FIXTURE=<file> bin/trigger-watchdog.sh`.

## Follow-ons (not in this PR)
- **1b — runs-API execution check:** needs a Hub-scoped prod read key (Bones mints
  in the Hub project's API keys). Adds the "0 EXECUTING + aging QUEUED backlog
  across ≥2 cycles" tell for a silent stall the status page hasn't posted yet.
- **Auto-failover:** per-run `.trigger(payload, { region })` override on the
  critical interactive Hub tasks; Solo writes a "healthy region" to a **Hub-side**
  store (Railway stays up during a Trigger outage). Hub-repo, Talha-coordinated.
- **External dead-man's-switch** (Healthchecks.io) for "Solo itself down."
- **Subscribe** `status.trigger.dev` (Better Stack email/RSS).

## Region-switch runbook (the 2026-06-22 fix)
Trigger.dev has no API to set the **default** region (dashboard-only). On a region
outage:
1. Confirm via this watchdog's alert + `https://status.trigger.dev`.
2. Trigger.dev dashboard → **Regions** → set the prod default to the healthy
   region (2026-06-22: us-east-1 → `eu-central-1` / Frankfurt). Pro plan = multi-region.
3. New runs execute in the new region within ~10s; in-flight runs pinned to the
   dead region must be cancelled + resubmitted (they won't self-heal cross-region).
4. Verify a fresh run COMPLETES in the new region before declaring recovery.
