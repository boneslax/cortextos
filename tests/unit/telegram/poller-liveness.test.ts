import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller, pollerIsStale } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';

// D0 liveness facts (PLAN-v3 §4b). The killer state: an offset past every real
// update_id makes getUpdates return empty forever. pollOnce returns early on an
// empty batch, so WITHOUT recording success on empty polls there is no fact that
// says "the loop is alive". lastSuccessfulPollAt must advance on EVERY successful
// getUpdates including empty; lastUpdateReceivedAt only when updates arrive. The
// PAIR distinguishes polling from receiving (zero updates is legit for an idle
// agent, so lastUpdateReceivedAt cannot alert alone).

describe('D0 poller liveness facts', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'poller-live-'));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('advances lastSuccessfulPollAt on an EMPTY poll (the killer-state guard)', async () => {
    const api = { botId: 1, getUpdates: vi.fn(async () => ({ result: [] })) } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);
    expect(poller.lastSuccessfulPollAt).toBe(0);

    const before = Date.now();
    await poller.pollOnce();

    expect(poller.lastSuccessfulPollAt).toBeGreaterThanOrEqual(before);
    // An empty poll is alive but received nothing.
    expect(poller.lastUpdateReceivedAt).toBe(0);
  });

  it('advances lastUpdateReceivedAt only when updates actually arrive', async () => {
    const api = {
      botId: 1,
      getUpdates: vi.fn(async () => ({ result: [{ update_id: 5, message: { message_id: 5, chat: { id: 1, type: 'private' }, text: 'hi' } }] })),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);

    const before = Date.now();
    await poller.pollOnce();

    expect(poller.lastSuccessfulPollAt).toBeGreaterThanOrEqual(before);
    expect(poller.lastUpdateReceivedAt).toBeGreaterThanOrEqual(before);
  });

  it('does NOT advance lastSuccessfulPollAt when getUpdates throws (a failed poll is not success)', async () => {
    const api = { botId: 1, getUpdates: vi.fn(async () => { throw new Error('boom'); }) } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);
    await expect(poller.pollOnce()).rejects.toThrow();
    expect(poller.lastSuccessfulPollAt).toBe(0);
  });
});

describe('pollerIsStale — pure staleness decision', () => {
  it('healthy: a poll within the threshold is not stale', () => {
    expect(pollerIsStale(1000, 1500, 60000)).toBe(false);
  });

  it('stale: no successful poll for longer than the threshold', () => {
    expect(pollerIsStale(1000, 100000, 60000)).toBe(true);
  });

  it('never polled (0) is stale once now exceeds the threshold', () => {
    expect(pollerIsStale(0, 70000, 60000)).toBe(true);
  });
});
