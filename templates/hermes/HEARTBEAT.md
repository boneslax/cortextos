# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING — except where the halt precondition in Step 1 fires, in which case
# you stop at Step 1, skip the rest, and log `cycle_halted`. A halt is a completed cycle, not a skipped one.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.
The ONE exception is the Step 1 halt precondition: when it fires you stop at Step 1 and log `cycle_halted`.
That is compliance, not a skip — and the resulting staleness is the intended signal, not a state to repair.

## Step 1: Update heartbeat (FIRST — but only after the halt precondition)

> **Halt precondition.** Before stamping liveness, confirm you actually read your own
> `HEARTBEAT.md`, `IDENTITY.md` and `GOALS.md` (your cron names them by absolute path). If ANY of
> the three is missing or unreadable, **do not update the heartbeat and do not write a memory
> entry** — run
> `cortextos bus log-event action cycle_halted error --meta '{"agent":"'$CTX_AGENT_NAME'","missing":"<file>"}'`
> and stop. Silent in the cadence channel, loud in the error channel.
>
> The PARTIAL case is the likely one: if HEARTBEAT.md reads and GOALS.md does not, a step-by-step
> execution of the old step 1 would stamp you alive before noticing, and a halted cycle that stamps
> liveness is indistinguishable from a healthy one. A halt is meant to surface as STALENESS. If you
> later read STALE after a halt, that is the signal — do not helpfully repair it.

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this command ERRORS, your agent shows as DEAD on the dashboard and the command itself is broken — fix that first. A DEAD reading after a deliberate halt is NOT that: it is the intended signal and the only thing the halt leaves behind. Never stamp liveness to clear a dashboard state you did not diagnose.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:
```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes.
Target: 0 un-ACK'd messages after this step.

## Step 3: Check task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- Pending tasks: pick the highest priority one and start it
- In-progress tasks older than 2 hours: complete them or update status with a note
- No tasks: check GOALS.md for objectives, then check with orchestrator

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M)
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Re-index memory to KB

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

## Step 7: Check GOALS.md

Read GOALS.md for any new objectives. If goals changed, create tasks:
```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME
```

## Step 8: Resume work

Pick your highest priority task and work on it.

```bash
cortextos bus update-task "<task_id>" in_progress
# ... do the work ...
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.

**This target does NOT apply to a halted cycle.** A halt produces 0 memory updates and exactly one
event, `cycle_halted`, by design — the halt forbids the memory write, and the missing artifacts ARE
the signal. Do not write a memory entry, fire filler events, or stamp a heartbeat to reach this
target after a halt: that manufactures the appearance of a cycle that refused to run, which is the
exact failure the halt exists to make visible. One `cycle_halted` event and nothing else is a
COMPLETE halted cycle.
