import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import { TelegramApiError } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

// D0: the offset file is now the bound { botId, offset } format, so the stub
// carries a botId for the load path to accept its persisted offset.
const STUB_BOT_ID = 5550001;

/** Read the persisted offset from the new bound format (was a bare integer). */
function persistedOffset(stateDir: string): string {
  const raw = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
  return String(JSON.parse(raw).offset);
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    botId: STUB_BOT_ID,
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = persistedOffset(stateDir);
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = String(JSON.parse(readFileSync(offsetFile, 'utf-8').trim()).offset);
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = persistedOffset(stateDir);
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? String(JSON.parse(readFileSync(f, 'utf-8').trim()).offset) : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = persistedOffset(stateDir);
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = persistedOffset(stateDir);
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = String(JSON.parse(readFileSync(offsetFile, 'utf-8').trim()).offset);
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = persistedOffset(stateDir);
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = String(JSON.parse(readFileSync(offsetFile, 'utf-8').trim()).offset);
      expect(persisted).toBe('0');
    }
  });
});

// REGRESSION (solo, PLAN-v3 §7 typed-error change): the 409 self-die at
// poller.ts matches /Conflict/i on err.message. When post() started throwing a
// TelegramApiError instead of a plain Error, the ONLY thing keeping that match
// alive is the preserved `.message` = "Telegram API error: <description>". This
// asserts the self-die actually FIRES with the typed error — a behaviour no
// type-check catches, and the exact "string quietly stops matching" failure the
// whole plan is about.
describe('TelegramPoller — 409 self-die survives the typed-error change', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'poller-conflict-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('sets conflict-self-die + stops when getUpdates throws a 409 TelegramApiError', async () => {
    const conflict = new TelegramApiError(
      'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
      409,
    );
    const api = {
      getUpdates: vi.fn(async () => {
        throw conflict;
      }),
    } as unknown as TelegramAPI;
    // Short interval so the (non-conflict) sleep path can't hang the test; the
    // conflict path returns before any sleep regardless.
    const poller = new TelegramPoller(api, stateDir, 5);

    await poller.start();

    expect(poller.lastExitReason).toBe('conflict-self-die');
    expect(poller.running).toBe(false);
  });

  it('does NOT self-die on a non-conflict TelegramApiError (keeps polling)', async () => {
    // A transient 502 must not be mistaken for a Conflict. It logs and continues,
    // so the loop is still running until stopped externally — proving the match
    // is specific to Conflict, not "any TelegramApiError".
    let calls = 0;
    const api = {
      getUpdates: vi.fn(async () => {
        calls++;
        throw new TelegramApiError('Bad Gateway', 502);
      }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir, 5);

    const runP = poller.start();
    // Let a couple of poll cycles happen, then stop it.
    await new Promise((r) => setTimeout(r, 30));
    poller.stop();
    await runP;

    expect(poller.lastExitReason).toBe('stopped-externally');
    expect(calls).toBeGreaterThan(1); // it kept polling, did not self-die
  });
});
