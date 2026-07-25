import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';

// D0 offset hardening (PLAN-v3 §4b). The offset is bound to the bot identity so
// a token rotation or a stateDir clobber cannot silently skip every update
// (getUpdates then returns empty forever -> D0/D1/D2 all green, Bones deaf).
// Parsing is strict (whole non-negative integer), writes are atomic.

const BOT_ID = 8913497784;

function stubApi(): { api: TelegramAPI; firstOffset: () => number | undefined } {
  const calls: number[] = [];
  const api = {
    botId: BOT_ID,
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      return { result: [] };
    }),
  } as unknown as TelegramAPI;
  return { api, firstOffset: () => calls[0] };
}

describe('D0 offset hardening — bind to botId, strict parse, atomic write', () => {
  let stateDir: string;
  const offsetFile = () => join(stateDir, '.telegram-offset');
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'poller-offset-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function effectiveOffset(): Promise<number> {
    const { api, firstOffset } = stubApi();
    const poller = new TelegramPoller(api, stateDir);
    await poller.pollOnce(); // first getUpdates reveals the loaded offset
    return firstOffset()!;
  }

  it('loads a matching {botId, offset} record', async () => {
    writeFileSync(offsetFile(), JSON.stringify({ botId: BOT_ID, offset: 42 }));
    expect(await effectiveOffset()).toBe(42);
  });

  it('DISCARDS the offset when the stored botId does NOT match (token rotation / clobber)', async () => {
    writeFileSync(offsetFile(), JSON.stringify({ botId: 111111, offset: 999999 }));
    expect(await effectiveOffset()).toBe(0);
  });

  it('rejects "12abc" (lenient parseInt would take 12) -> 0', async () => {
    writeFileSync(offsetFile(), '12abc');
    expect(await effectiveOffset()).toBe(0);
  });

  it('rejects a negative offset (Telegram gives negatives special meaning) -> 0', async () => {
    writeFileSync(offsetFile(), JSON.stringify({ botId: BOT_ID, offset: -1 }));
    expect(await effectiveOffset()).toBe(0);
  });

  it('rejects a non-integer offset -> 0', async () => {
    writeFileSync(offsetFile(), JSON.stringify({ botId: BOT_ID, offset: 3.7 }));
    expect(await effectiveOffset()).toBe(0);
  });

  it('rejects garbage -> 0', async () => {
    writeFileSync(offsetFile(), '{not json');
    expect(await effectiveOffset()).toBe(0);
  });

  it('SAVES the new {botId, offset} format (bound, so a later load can verify provenance)', async () => {
    const calls: number[] = [];
    const api = {
      botId: BOT_ID,
      getUpdates: vi.fn(async (offset: number) => {
        calls.push(offset);
        // deliver one update so the offset advances + persists
        return { result: [{ update_id: 500, message: { message_id: 500, chat: { id: 1, type: 'private' }, text: 'hi' } }] };
      }),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);
    await poller.pollOnce();

    const persisted = JSON.parse(readFileSync(offsetFile(), 'utf-8'));
    expect(persisted).toEqual({ botId: BOT_ID, offset: 501 });
  });

  it('a saved offset round-trips (save then load gives the same value)', async () => {
    writeFileSync(offsetFile(), JSON.stringify({ botId: BOT_ID, offset: 700 }));
    expect(await effectiveOffset()).toBe(700);
  });

  // Solo's decision A: a legacy bare-integer file has no provenance, so it is an
  // unknown and unknowns do not resolve reassuringly. Discard -> 0 -> stamp.
  // One-time per agent on first D0 deploy; getUpdates has already forgotten
  // every confirmed update below it, so the reset re-pulls ~nothing.
  it('DISCARDS a legacy bare-integer offset (no botId) -> 0, and LOGS it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(offsetFile(), '935731451');
    const eff = await effectiveOffset();
    expect(eff).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/legacy offset.*935731451.*reset/i));
    warn.mockRestore();
  });

  it('after a legacy discard, the next save stamps the botId (branch never runs again)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(offsetFile(), '935731451');
    const api = {
      botId: BOT_ID,
      getUpdates: vi.fn(async () => ({ result: [{ update_id: 10, message: { message_id: 10, chat: { id: 1, type: 'private' }, text: 'x' } }] })),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);
    await poller.pollOnce();
    const persisted = JSON.parse(readFileSync(offsetFile(), 'utf-8'));
    expect(persisted).toEqual({ botId: BOT_ID, offset: 11 });
  });
});
