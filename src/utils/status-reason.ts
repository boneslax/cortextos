/**
 * Rendering a task's status reason as a self-describing verdict.
 *
 * WHY THIS MODULE EXISTS SEPARATELY FROM `src/bus/task.ts`
 *
 * `task.ts` imports `fs`, `path`, the atomic-write helpers and the event
 * logger. Anything that imports it drags the whole server-side graph along.
 * This file imports NOTHING, so a second consumer (the dashboard's sync
 * derivation) can use it without pulling a filesystem dependency into a
 * Next.js bundle.
 *
 * WHY THE COMPARISON IS `rev` AND NOT `status`
 *
 * The obvious design — stamp the reason with the status it explains, then
 * compare that against the task's current status — is WRONG, and it fails in
 * the most common direction:
 *
 *     blocked (reason "waiting on the vendor")
 *       -> in_progress   (no reason given)
 *       -> blocked       (no reason given)
 *
 * After the third transition `stamp.status === task.status` again, so a
 * status-comparison reports a MATCH and renders a reason from a CLOSED
 * EPISODE as the explanation for the current one. The guard goes silent
 * exactly when it should fire, because the two statuses agree. Re-blocking
 * is the single most common repeat transition, so this is the likely case
 * rather than the exotic one.
 *
 * A monotonic `rev` cannot recycle. `stamp.rev === task.rev` is true only
 * when no transition has happened since the reason was written.
 *
 * Deliberately NOT `updated_at`: those timestamps have their milliseconds
 * stripped (`.replace(/\.\d{3}Z$/, 'Z')`), so two transitions inside one
 * second compare equal — the same granularity trap that makes a
 * compare-and-swap on `updated_at` unable to fire.
 *
 * ABSENCE IS NEVER TREATED AS CURRENCY. A stamp with no `rev`, or a task
 * with no `rev` (every task file written before this shipped), cannot be
 * shown to belong to the current transition — so it is rendered as history.
 * Claiming "current" requires positive evidence, never the absence of
 * contrary evidence.
 */

/** The five task statuses. Mirrors `TaskStatus` in `../types/index.ts`. */
export type StatusReasonStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';

/**
 * Why a task arrived at a status, stamped with the transition that wrote it.
 *
 * `rev` is the value of `Task.rev` at the moment of writing. It is optional
 * only so that records written by older code still parse; a stamp without
 * one can never render as current.
 */
export interface StatusReason {
  /** The status this reason explains. */
  status: StatusReasonStatus;
  /** The operator's text, verbatim and unmodified. */
  reason: string;
  /** ISO 8601, for display and ordering. NOT used for currency. */
  at: string;
  /** `Task.rev` when written. Absent on pre-`rev` records. */
  rev?: number;
}

/** The subset of a task this module needs. Structural, so both the core
 *  `Task` and the dashboard's row type satisfy it without a shared import. */
export interface StatusReasonSubject {
  status: string;
  rev?: number;
  status_reason?: StatusReason;
}

/**
 * Render the reason as a verdict a reader can act on without holding a
 * second value in their head.
 *
 * Returns `null` when there is no reason to show — which a caller must
 * render as genuinely empty, NOT as "no reason given". Those are different
 * claims: one says nothing was ever recorded, the other says this task's
 * current status was set without one.
 *
 *   current, with text   ->  "[blocked] vendor pushed the cutover to Q4"
 *   current, empty text  ->  "[blocked] (no reason given)"
 *   historical           ->  "[was blocked] vendor pushed the cutover to Q4"
 *
 * The operator's text is never parsed, stripped, or rewritten. A reason that
 * happens to begin with "[blocked]" renders with both prefixes visible,
 * which is honest: one is ours and one is theirs, and silently editing
 * operator text to look tidier is the failure this whole record exists to
 * fix.
 */
export function formatStatusReason(task: StatusReasonSubject): string | null {
  const sr = task.status_reason;
  if (!sr) return null;

  // Positive evidence only: both revs must be present AND equal.
  const isCurrent =
    typeof sr.rev === 'number' &&
    typeof task.rev === 'number' &&
    sr.rev === task.rev;

  const label = isCurrent ? `[${sr.status}]` : `[was ${sr.status}]`;
  const text = sr.reason.trim() === '' ? '(no reason given)' : sr.reason;
  return `${label} ${text}`;
}

/**
 * True only when the stamp provably belongs to the task's current
 * transition. Exposed so a caller can branch on currency without parsing
 * the rendered string — parsing our own output back is how a display
 * convention turns into a data format.
 */
export function isStatusReasonCurrent(task: StatusReasonSubject): boolean {
  const sr = task.status_reason;
  if (!sr) return false;
  return (
    typeof sr.rev === 'number' &&
    typeof task.rev === 'number' &&
    sr.rev === task.rev
  );
}
