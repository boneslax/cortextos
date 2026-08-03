# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING — except where the halt precondition in Step 1 fires, in which case
# you stop at Step 1, skip the rest, and log `cycle_halted`. A halt is a completed cycle, not a skipped one.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.
The ONE exception is the Step 1 halt precondition: when it fires you stop at Step 1 and log `cycle_halted`.
That is compliance, not a skip — and the resulting staleness is the intended signal, not a state to repair. The dashboard monitors your compliance.

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

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon — you don't need to poll for them. This step is a safety sweep for anything that wasn't ACK'd (e.g. a crash mid-processing).

Full reference: `.claude/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

## Step 3: Fleet health check (ORCHESTRATOR — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`
Approvals reference: `.claude/skills/approvals/SKILL.md`
Human tasks reference: `.claude/skills/human-tasks/SKILL.md`

```bash
# Check all agent heartbeats
cortextos bus read-all-heartbeats

# Check all pending approvals. No 2>/dev/null -- see the note below; a swallowed
# error here reads identically to "no approvals pending".
cortextos bus list-approvals --format json

# Check stale human tasks.
# NO --project: the flag does not exist and `list-tasks` exits 1 with
#   error: unknown option '--project'
# The 2>/dev/null this line used to carry then ate the error, so the step
# printed nothing and read exactly like "no human tasks pending".
# NO --status pending either: it hides `blocked` and `in_progress`. On
# 2026-07-28 that was 13 of 36 open tasks.
# Query unfiltered and treat any non-terminal status as open. Never
# redirect stderr here -- a failed sweep is UNKNOWN, not clean.
cortextos bus list-tasks --format json
# Then filter: status not in (completed, cancelled) = open;
# escalate open rows whose title carries [HUMAN] and are older than 4h.
```

For each agent: if heartbeat is older than 5 hours, send an alert to that agent and flag in memory.

For any pending approval older than 4 hours: ping the user via Telegram.
For any [HUMAN] task pending longer than 4 hours: ping the user via Telegram.

```bash
# Example: ping user about stale approval or human task
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Pending approval needs your decision: <title> — check dashboard"
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "[HUMAN] task waiting on you: <title> — blocking <agent> on <parent task>"
```

## Step 3b: Check own task queue + stale task detection

Full reference: `.claude/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status blocked
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, generate tasks for specialist agents

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

Full reference: `.claude/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `.claude/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC) / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check org goals state

Full reference: `.claude/skills/goal-management/SKILL.md`

```bash
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json
```

- If `daily_focus_set_at` is not today AND it is before 10 AM: trigger morning review now — read `.claude/skills/morning-review/SKILL.md`
- If `north_star` is empty: message user via Telegram to set it
- If any agent has an empty `goals.json` (focus and goals both empty): write their goals and regenerate GOALS.md

Also read your own GOALS.md for any manual overrides or notes you left yourself.

## Step 7: Resume work

Full reference: `.claude/skills/tasks/SKILL.md`

Pick your highest priority task and work on it. Tasks should trace back to your current goals.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

## Step 8: Guardrail self-check

Full reference: `.claude/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `.claude/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

## Step 10: Re-ingest memory to knowledge base

Full reference: `.claude/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.

**This target does NOT apply to a halted cycle.** A halt produces 0 memory updates and exactly one
event, `cycle_halted`, by design — the halt forbids the memory write, and the missing artifacts ARE
the signal. Do not write a memory entry, fire filler events, or stamp a heartbeat to reach this
target after a halt: that manufactures the appearance of a cycle that refused to run, which is the
exact failure the halt exists to make visible. One `cycle_halted` event and nothing else is a
COMPLETE halted cycle.
