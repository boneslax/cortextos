/**
 * Dead-letter capture (PLAN-v3 §9) — PURE-ish (fs only, no network).
 *
 * When the chat-scope guard drops an inbound update, the update is destroyed:
 * the offset advances and Telegram forgets it. v2.3 called that loss
 * "unavoidable"; it is not. Appending the dropped update to a local JSONL makes
 * it replayable after a heal (replay itself is phase 2).
 *
 * This is a NEW on-disk store of the operator's real message content, so it is
 * BOUNDED (solo's ask C): capped record count AND age, and idempotent on
 * update_id so a re-drop of the same update never double-stores.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';

export interface DeadLetterRecord {
  /**
   * Idempotency key. At the chat-scope-guard drop seam the handler has the
   * MESSAGE (message_id + chat), not the raw update, so the key is
   * `${chatId}:${message_id}` — unique per message and the natural unit for
   * replay. (The plan says "update_id"; that field is not available at the drop
   * seam, and message identity is the correct replay key regardless.)
   */
  key: string;
  archived_at: number; // epoch-ms
  payload: unknown; // the dropped message, for replay
}

export interface DeadLetterBounds {
  maxRecords: number;
  maxAgeMs: number;
}

export const DEAD_LETTER_FILE = '.telegram-dead-letter.jsonl';

export const DEFAULT_DEAD_LETTER_BOUNDS: DeadLetterBounds = {
  maxRecords: 500,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/** Read all currently-stored dead-letter records (skips any corrupt line). */
export function readDeadLetter(stateDir: string): DeadLetterRecord[] {
  const file = join(stateDir, DEAD_LETTER_FILE);
  if (!existsSync(file)) return [];
  const out: DeadLetterRecord[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.key === 'string') out.push(rec);
    } catch {
      // Skip a corrupt line rather than throw — one torn append must not make
      // the whole store unreadable.
    }
  }
  return out;
}

/**
 * Append a dropped message to the dead-letter store, enforcing bounds.
 * - Idempotent: a `key` already present is NOT appended again.
 * - Age-pruned: records older than maxAgeMs are dropped on write.
 * - Count-bounded: only the newest maxRecords are kept (oldest evicted).
 * Returns the record count after the write.
 */
export function appendDeadLetter(
  stateDir: string,
  key: string,
  payload: unknown,
  now: number,
  bounds: DeadLetterBounds = DEFAULT_DEAD_LETTER_BOUNDS,
): number {
  ensureDir(stateDir);
  const existing = readDeadLetter(stateDir);

  // Idempotent: a re-drop of the same key must not double-store.
  if (existing.some((r) => r.key === key)) {
    return existing.length;
  }

  let records = [...existing, { key, archived_at: now, payload }];
  // Age prune, then count cap (keep the newest).
  const cutoff = now - bounds.maxAgeMs;
  records = records.filter((r) => r.archived_at >= cutoff);
  if (records.length > bounds.maxRecords) {
    records = records.slice(records.length - bounds.maxRecords);
  }

  const file = join(stateDir, DEAD_LETTER_FILE);
  atomicWriteSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return records.length;
}
