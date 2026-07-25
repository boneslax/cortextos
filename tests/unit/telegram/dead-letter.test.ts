import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendDeadLetter, readDeadLetter, DEAD_LETTER_FILE } from '../../../src/telegram/dead-letter';

// PLAN-v3 §9: dead-letter capture with bounds. It stores the operator's real
// message content, so growth must be capped (count + age) and idempotent on the
// key — a re-drop must never double-store, or a replay loop that re-drops
// becomes a growth bug on top of a delivery bug. The key at the drop seam is
// `${chatId}:${message_id}` (the raw update_id isn't available there).

const msg = (id: number, text = 'x') => ({
  message_id: id,
  chat: { id: -100, type: 'supergroup' },
  text,
});
const key = (chatId: number, msgId: number) => `${chatId}:${msgId}`;

describe('dead-letter capture (PLAN-v3 §9)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'deadletter-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('appends a dropped message, readable back with its key + payload', () => {
    appendDeadLetter(stateDir, key(-100, 10), msg(10, 'hello'), 1000);
    const recs = readDeadLetter(stateDir);
    expect(recs).toHaveLength(1);
    expect(recs[0].key).toBe('-100:10');
    expect(recs[0].archived_at).toBe(1000);
    expect((recs[0].payload as any).text).toBe('hello');
  });

  it('is IDEMPOTENT on key — the same message dropped twice stores once', () => {
    appendDeadLetter(stateDir, key(-100, 10), msg(10), 1000);
    appendDeadLetter(stateDir, key(-100, 10), msg(10), 2000);
    expect(readDeadLetter(stateDir)).toHaveLength(1);
  });

  it('distinct chats with the same message_id are distinct keys', () => {
    appendDeadLetter(stateDir, key(-100, 10), msg(10), 1000);
    appendDeadLetter(stateDir, key(-200, 10), msg(10), 1000);
    expect(readDeadLetter(stateDir)).toHaveLength(2);
  });

  it('COUNT-bounds: keeps only the newest maxRecords (oldest evicted)', () => {
    const bounds = { maxRecords: 3, maxAgeMs: 1_000_000 };
    for (let i = 1; i <= 5; i++) appendDeadLetter(stateDir, key(-100, i), msg(i), 1000 + i, bounds);
    const recs = readDeadLetter(stateDir);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.key)).toEqual(['-100:3', '-100:4', '-100:5']); // 1,2 evicted
  });

  it('AGE-bounds: prunes records older than maxAgeMs on write', () => {
    const bounds = { maxRecords: 100, maxAgeMs: 500 };
    appendDeadLetter(stateDir, key(-100, 1), msg(1), 1000, bounds);
    appendDeadLetter(stateDir, key(-100, 2), msg(2), 1400, bounds);
    appendDeadLetter(stateDir, key(-100, 3), msg(3), 1600, bounds); // now=1600, cutoff=1100 -> id1(1000) pruned
    const recs = readDeadLetter(stateDir);
    expect(recs.map((r) => r.key)).toEqual(['-100:2', '-100:3']);
  });

  it('returns the post-write record count', () => {
    expect(appendDeadLetter(stateDir, key(-100, 1), msg(1), 1000)).toBe(1);
    expect(appendDeadLetter(stateDir, key(-100, 2), msg(2), 1000)).toBe(2);
  });

  it('readDeadLetter tolerates a corrupt line without throwing', () => {
    appendDeadLetter(stateDir, key(-100, 1), msg(1), 1000);
    const f = join(stateDir, DEAD_LETTER_FILE);
    writeFileSync(f, readFileSync(f, 'utf-8') + '{not json\n');
    const recs = readDeadLetter(stateDir);
    expect(recs).toHaveLength(1);
    expect(recs[0].key).toBe('-100:1');
  });
});
