import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, readTaskAudit } from '../../../src/bus/task';
import { formatStatusReason } from '../../../src/utils/status-reason';
import { atomicWriteSync } from '../../../src/utils/atomic';
import type { BusPaths, Task } from '../../../src/types';

/**
 * Persistence half of the status-reason work. The renderer is unit-tested in
 * `tests/unit/utils/status-reason.test.ts`; this file asserts the fields
 * actually reach disk and survive being read back.
 *
 * Every assertion reads the JSON off disk rather than trusting a return
 * value — a function that returns cleanly and writes nothing is the exact
 * shape this record exists to catch. Mutation log:
 * `tests/unit/bus/task-status-reason.mutations.md`.
 */

let root: string;
let paths: BusPaths;

function read(id: string): Task {
  return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-sr-'));
  paths = {
    ctxRoot: root,
    taskDir: join(root, 'tasks'),
    analyticsDir: join(root, 'analytics'),
  } as BusPaths;
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function make(title = 'probe'): string {
  return createTask(paths, 'dev-delegate', 'testorg', title);
}

describe('updateTask --reason persistence', () => {
  it('writes status_reason to disk, stamped with the status and the rev', () => {
    const id = make();
    updateTask(paths, id, 'blocked', 'vendor pushed the cutover to Q4');
    const t = read(id);
    expect(t.status).toBe('blocked');
    expect(t.status_reason).toBeDefined();
    expect(t.status_reason!.reason).toBe('vendor pushed the cutover to Q4');
    expect(t.status_reason!.status).toBe('blocked');
    expect(t.status_reason!.rev).toBe(t.rev);
    // A blocked task has produced nothing, so `result` must stay clear —
    // the two fields are different claims.
    expect(t.result).toBeUndefined();
    expect(t.completed_at).toBeNull();
  });

  it('bumps rev on EVERY transition, with or without a reason', () => {
    const id = make();
    updateTask(paths, id, 'in_progress');
    const a = read(id).rev!;
    updateTask(paths, id, 'blocked', 'waiting');
    const b = read(id).rev!;
    updateTask(paths, id, 'in_progress');
    const c = read(id).rev!;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  /**
   * THE END-TO-END VERSION OF THE CASE THAT KILLED v6.
   *
   * blocked(reason) -> in_progress -> blocked, no reason on either later
   * transition. The statuses agree again on the third step, so a
   * status-comparison design renders the first episode's reason as the
   * current explanation. Here the stamp's rev is stale, so it must render
   * as history.
   */
  it('does not resurrect a reason when the same status is re-entered', () => {
    const id = make();
    updateTask(paths, id, 'blocked', 'waiting on the vendor');
    updateTask(paths, id, 'in_progress');
    updateTask(paths, id, 'blocked');

    const t = read(id);
    expect(t.status).toBe('blocked');
    expect(t.status_reason!.status).toBe('blocked'); // statuses DO agree
    expect(t.status_reason!.rev).not.toBe(t.rev); // ...but the revs do not
    expect(formatStatusReason(t)).toBe('[was blocked] waiting on the vendor');
  });

  it('leaves a prior stamp intact on a reason-less transition', () => {
    const id = make();
    updateTask(paths, id, 'blocked', 'original text');
    updateTask(paths, id, 'in_progress');
    const t = read(id);
    // Not cleared (that destroys the record) and not rewritten (that
    // fabricates one). It simply stops being current.
    expect(t.status_reason!.reason).toBe('original text');
    expect(formatStatusReason(t)).toBe('[was blocked] original text');
  });

  it('records the reason in the append-only audit note', () => {
    const id = make();
    updateTask(paths, id, 'cancelled', 'one job, two records — not done');
    const entries = readTaskAudit(paths, id);
    const update = entries.filter((e) => e.event === 'update').pop();
    expect(update?.note).toBe('one job, two records — not done');
  });
});

describe('completeTask keeps result and status_reason separate', () => {
  it('carries both, because they are different claims', () => {
    const id = make();
    completeTask(paths, id, 'shipped the connector', 'ended early, auth deferred');
    const t = read(id);
    expect(t.result).toBe('shipped the connector');
    expect(t.status_reason!.reason).toBe('ended early, auth deferred');
    expect(t.status_reason!.status).toBe('completed');
    expect(t.status_reason!.rev).toBe(t.rev);
    expect(formatStatusReason(t)).toBe('[completed] ended early, auth deferred');
  });

  it('a result with no reason leaves status_reason unset', () => {
    const id = make();
    completeTask(paths, id, 'shipped the connector');
    const t = read(id);
    expect(t.result).toBe('shipped the connector');
    expect(t.status_reason).toBeUndefined();
    expect(formatStatusReason(t)).toBeNull();
  });
});

describe('backward compatibility', () => {
  it('an existing task with no rev gains one on its first transition', () => {
    const id = make();
    const before = read(id);
    delete (before as { rev?: number }).rev;
    // Simulate a pre-feature record on disk.
    atomicWriteSync(join(paths.taskDir, `${id}.json`), JSON.stringify(before));
    expect(read(id).rev).toBeUndefined();

    updateTask(paths, id, 'blocked', 'first reason after the upgrade');
    const t = read(id);
    expect(t.rev).toBe(1);
    expect(t.status_reason!.rev).toBe(1);
    expect(formatStatusReason(t)).toBe('[blocked] first reason after the upgrade');
  });
});
