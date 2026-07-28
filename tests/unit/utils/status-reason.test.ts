import { describe, it, expect } from 'vitest';
import {
  formatStatusReason,
  isStatusReasonCurrent,
  type StatusReasonSubject,
} from '../../../src/utils/status-reason';

/**
 * Every test here was proven RED against a deliberately broken
 * implementation before being allowed to go green — see
 * `tests/unit/utils/status-reason.mutations.md` for the mutation, the
 * command, and the failure each one produced. A test that has never been
 * observed failing is not evidence that it can.
 */

function subject(over: Partial<StatusReasonSubject> = {}): StatusReasonSubject {
  return {
    status: 'blocked',
    rev: 7,
    status_reason: {
      status: 'blocked',
      reason: 'vendor pushed the cutover to Q4',
      at: '2026-07-27T12:00:00Z',
      rev: 7,
    },
    ...over,
  };
}

describe('formatStatusReason', () => {
  it('returns null when there is no reason at all', () => {
    expect(formatStatusReason(subject({ status_reason: undefined }))).toBeNull();
  });

  it('renders the current form when the stamp belongs to this transition', () => {
    expect(formatStatusReason(subject())).toBe(
      '[blocked] vendor pushed the cutover to Q4',
    );
  });

  it('renders the historical form when a later transition has happened', () => {
    const t = subject({ status: 'in_progress', rev: 8 });
    expect(formatStatusReason(t)).toBe(
      '[was blocked] vendor pushed the cutover to Q4',
    );
  });

  /**
   * THE CASE THAT KILLED THE PREVIOUS DESIGN.
   *
   * A status-comparison guard (`stamp.status === task.status`) reports a
   * MATCH here, because the task really is `blocked` again — and renders a
   * reason from a closed episode as the explanation for the current one.
   * The guard is silent precisely because the statuses agree.
   *
   * Sequence: blocked(reason) -> in_progress -> blocked, with no reason
   * given on either later transition. Re-blocking is the most common
   * repeat transition, so this is the likely path, not an exotic one.
   */
  it('does NOT resurrect a reason when the same status is entered again', () => {
    const recycled = subject({
      status: 'blocked', // same status as the stamp
      rev: 9, // ...but two transitions later
    });
    expect(formatStatusReason(recycled)).toBe(
      '[was blocked] vendor pushed the cutover to Q4',
    );
    expect(isStatusReasonCurrent(recycled)).toBe(false);
  });

  it('treats a stamp with no rev as historical, never current', () => {
    const t = subject();
    delete (t.status_reason as { rev?: number }).rev;
    expect(formatStatusReason(t)).toBe(
      '[was blocked] vendor pushed the cutover to Q4',
    );
  });

  it('treats a task with no rev as historical, never current', () => {
    expect(formatStatusReason(subject({ rev: undefined }))).toBe(
      '[was blocked] vendor pushed the cutover to Q4',
    );
  });

  /**
   * BOTH revs absent — the case every task file in the store is in today.
   *
   * Found by a surviving mutant, not by design. Dropping the `typeof`
   * guards leaves `sr.rev === task.rev`, and `undefined === undefined` is
   * TRUE, so a legacy record would render as CURRENT. The two tests above
   * each pin one side absent and the other present, so both survive that
   * mutation; only the both-absent case constrains it.
   *
   * This is not hypothetical: no existing task file carries a `rev`, so on
   * the day this ships every pre-existing stamp takes this path.
   */
  it('treats BOTH revs absent as historical — undefined must not equal undefined', () => {
    const t = subject({ rev: undefined });
    delete (t.status_reason as { rev?: number }).rev;
    expect(isStatusReasonCurrent(t)).toBe(false);
    expect(formatStatusReason(t)).toBe(
      '[was blocked] vendor pushed the cutover to Q4',
    );
  });

  it('distinguishes "no reason given" from "no reason recorded"', () => {
    expect(formatStatusReason(subject({ status_reason: undefined }))).toBeNull();
    const blank = subject();
    blank.status_reason!.reason = '   ';
    expect(formatStatusReason(blank)).toBe('[blocked] (no reason given)');
  });

  it('never rewrites operator text that looks like our own prefix', () => {
    const t = subject();
    t.status_reason!.reason = '[blocked] deployment done';
    // Both prefixes visible: one is ours, one is theirs. Silently editing
    // operator text to look tidier is the failure this record exists to fix.
    expect(formatStatusReason(t)).toBe('[blocked] [blocked] deployment done');
  });

  it('renders every status label from the stamp, not from the task', () => {
    for (const s of ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] as const) {
      const t = subject();
      t.status_reason!.status = s;
      expect(formatStatusReason(t)).toBe(`[${s}] vendor pushed the cutover to Q4`);
    }
  });
});

describe('isStatusReasonCurrent', () => {
  it('agrees with the rendered form in every case', () => {
    const cases: StatusReasonSubject[] = [
      subject(),
      subject({ rev: 8 }),
      subject({ status: 'blocked', rev: 9 }),
      subject({ rev: undefined }),
      subject({ status_reason: undefined }),
    ];
    for (const t of cases) {
      const rendered = formatStatusReason(t);
      const current = isStatusReasonCurrent(t);
      if (rendered === null) {
        expect(current).toBe(false);
      } else {
        expect(current).toBe(rendered.startsWith('[was ') === false);
      }
    }
  });
});
