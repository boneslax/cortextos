import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cacheLastSent, readLastSent, lastSentFileName, logOutboundMessage, recordInboundTelegram, buildRecentHistory } from '../../../src/telegram/logging.js';

// v2 multi-topic context isolation: last-sent + recent-history must be keyed by
// (chat, topic) when a thread is present, so two project topics in one group do
// not bleed into each other — while DM/v1 (no thread) stays byte-identical.

let ctxRoot: string;
beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'thr-state-')); });
afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

const CHAT = '-100123';

describe('thread-aware last-sent cache', () => {
  it('isolates last-sent per topic; DM (no thread) keeps the bare filename', () => {
    cacheLastSent(ctxRoot, 'dev', CHAT, 'reply in topic 2', 2);
    cacheLastSent(ctxRoot, 'dev', CHAT, 'reply in topic 5', 5);
    cacheLastSent(ctxRoot, 'dev', CHAT, 'dm reply');
    expect(readLastSent(ctxRoot, 'dev', CHAT, 2)).toBe('reply in topic 2');
    expect(readLastSent(ctxRoot, 'dev', CHAT, 5)).toBe('reply in topic 5');
    expect(readLastSent(ctxRoot, 'dev', CHAT)).toBe('dm reply');
  });

  it('filename convention: bare for no-thread, -t<id> suffix with thread', () => {
    expect(lastSentFileName(CHAT)).toBe(`last-telegram-${CHAT}.txt`);
    expect(lastSentFileName(CHAT, 2)).toBe(`last-telegram-${CHAT}-t2.txt`);
  });
});

describe('thread-aware recent history', () => {
  function inbound(text: string, threadId?: number) {
    recordInboundTelegram(
      { ctxRoot } as any, ctxRoot, 'dev', 'vault', 'B',
      { message_id: 1, chat: { id: Number(CHAT), type: 'supergroup' }, text, ...(threadId !== undefined ? { message_thread_id: threadId } : {}) } as any,
    );
  }
  it('only returns history for the requested topic; thread-less for DM', () => {
    inbound('topic 2 message A', 2);
    inbound('topic 5 message B', 5);
    inbound('dm message C');
    logOutboundMessage(ctxRoot, 'dev', CHAT, 'topic 2 reply', 10, undefined, 2);

    const h2 = buildRecentHistory(ctxRoot, 'dev', CHAT, 6, 2) ?? '';
    expect(h2).toContain('topic 2 message A');
    expect(h2).toContain('topic 2 reply');
    expect(h2).not.toContain('topic 5 message B');
    expect(h2).not.toContain('dm message C');

    const hDm = buildRecentHistory(ctxRoot, 'dev', CHAT, 6) ?? '';
    expect(hDm).toContain('dm message C');
    expect(hDm).not.toContain('topic 2 message A');
    expect(hDm).not.toContain('topic 5 message B');
  });
});
