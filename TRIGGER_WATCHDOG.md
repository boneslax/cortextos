# Trigger.dev Watchdog (independent outage monitor)

Independent monitor for Trigger.dev outages, born from the 2026-06-22 us-east-1
outage that took down Hub automations AND the Trigger-based watchdog (a monitor
can't live on the infra it monitors). Runs from the **system crontab** on Solo —
NOT a cortextOS agent-prompt cron (those need the agent/LLM alive) — so it
survives both a Trigger.dev outage and the cortextOS daemon/LLM being down.

`bin/trigger-watchdog.sh` — pure shell, no npm deps, never spawns Claude.

## Trigger = IMPACT (1b): does HIS prod actually stall
**Why impact-not-status (first-fire learning, 2026-06-24):** the 1a status-only
version paged on `aggregate_state=downtime` — but that fired on a **non-used region
(eu-central-1) flapping** while Bones's prod (us-east-1) executed fine. So
`status=downtime ≠ his-automations-impacted`. Bones's requirement: *"check if MY
automations are impacted before alerting."*

So the **page trigger is the runs-API impact check** across BOTH Hub prod Trigger
projects (`hubapp` = primary `proj_luyejwcyhjfojxxgwlit`; `helpdesk` = secondary
`proj_dmalyhsdqqxehlagufef`). A project is **STALLED** only when, in its prod:
`EXECUTING == 0` **AND** an aging `QUEUED` backlog (oldest > `WATCHDOG_STALL_MIN`,
default 10m) **AND** nothing `COMPLETED` within `STALL_MIN` — the exact 2026-06-22
signature. PAGE on a STALL in **either** project, sustained ≥2 cycles (debounce);
recovery message on clear. A **momentary 0-EXECUTING snapshot is NORMAL** (per-minute
cron ticks) and does NOT page — the age + last-completed gates + the debounce kill it.

**status.trigger.dev is CONTEXT, never the trigger** — fetched + included in the
page/log for color; status-degraded-while-his-prod-executes is INFO only.
**Region-aware for free:** if his runs execute, no page, whatever region the status
page flags.

**Credential:** per-project prod READ keys from 1Password item `Trigger.dev`
(`chagb6unxtfqljbcrxu4pxmqxe`, fields `hubapp_prod_read_key` / `helpdesk_prod_read_key`),
pulled at runtime via the service account, passed to `curl` through a **0600
`--config`** file (Bearer never in argv; `--globoff` for the `[ ]` filter params).
If a key is unavailable → that project's check is skipped + logged, **never paged**.

Alert path: `cortextos bus send-telegram … --plain-text`, with a **raw-curl Telegram
fallback** if the cortextOS CLI itself is broken. Per-incident timestamped marker
(`$CTX_ROOT/state/trigger-watchdog/incident-active.json`); state re-derived every run;
recovery sent only if the recovery message actually delivers.

## Install (run on Solo, with solo)
```bash
# every 3 minutes; adjust paths/agent as needed
*/3 * * * * CORTEXTOS_BIN=/usr/bin/cortextos /home/bones/cortextos/bin/trigger-watchdog.sh
```
Defaults target the Solo deployment (`CTX_ROOT=/home/bones/.cortextos/default`,
`CTX_ORG=vault`, bus agent `solo`); the alert chat + raw-curl token are read from
the `solo` agent `.env` (`CHAT_ID`/`TOPIC_ID`/`BOT_TOKEN`); the per-project prod read
keys come from 1Password at runtime (service account). Tunables: `WATCHDOG_STALL_MIN`
(default 10), `WATCHDOG_MIN_QUEUED`, `WATCHDOG_CHAT_ID`, `WATCHDOG_THREAD_ID`.
**Re-enable the muted cron only with this impact-gate in place.** Test isolation:
runs are fixture-injectable (`WATCHDOG_RUNS_FIXTURE_<label>_<STATUS>=<file>`,
`WATCHDOG_STATUS_FIXTURE`), and tests force `TELEGRAM_API_BASE` at a dead endpoint +
`CORTEXTOS_BIN`/`OP_SA_TOKEN_FILE=/nonexistent` so a real send is structurally
impossible (a 2026-06-24 non-dry test leaked the real token + false-paged Bones —
never run the watchdog non-dry against the real env outside an announced smoke test).

## Follow-ons (not in this PR)
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
