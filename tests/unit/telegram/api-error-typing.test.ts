import { describe, it, expect, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// Phase-1 prerequisite (PLAN-v3 §7): post() must surface error_code AND
// result.parameters on the thrown error, not just the prose description.
// Classifying on prose is a substring match on Telegram's wording — it breaks
// toward `unclassified` the day they reword. And parameters.migrate_to_chat_id
// is the free healing signal for exactly the migration incident this plan fixes.
//
// HARD CONSTRAINT (solo, regression flag): the thrown error's .message must stay
// VERBATIM `Telegram API error: <description>`. Four consumers match on that
// string — poller.ts:100 /Conflict/i self-die, three internal
// startsWith('Telegram API error') re-throws, and two /Telegram API error/
// validate classifiers. error_code/parameters are NEW fields ALONGSIDE .message,
// never a replacement.

function mockFetchJson(body: any) {
  return vi.fn(async () => ({
    json: async () => body,
  })) as any;
}

describe('post() typed error — carries error_code + parameters (PLAN-v3 §7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('surfaces error_code on the thrown error', async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    const api = new TelegramAPI('123:TEST');
    await expect(api.getChat('-100999')).rejects.toMatchObject({ error_code: 400 });
  });

  it('surfaces result.parameters (incl. migrate_to_chat_id — the free heal signal)', async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error_code: 400,
      description: 'Bad Request: group chat was upgraded to a supergroup chat',
      parameters: { migrate_to_chat_id: -1004463276612 },
    });
    const api = new TelegramAPI('123:TEST');
    await expect(api.getChat('-5552913357')).rejects.toMatchObject({
      error_code: 400,
      parameters: { migrate_to_chat_id: -1004463276612 },
    });
  });

  it('surfaces retry_after from parameters on a 429', async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    });
    const api = new TelegramAPI('123:TEST');
    await expect(api.getMe()).rejects.toMatchObject({
      error_code: 429,
      parameters: { retry_after: 5 },
    });
  });

  it('KEEPS .message verbatim `Telegram API error: <description>` (backward compat)', async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    });
    const api = new TelegramAPI('123:TEST');
    await expect(api.getChat('-100999')).rejects.toThrow(
      'Telegram API error: Bad Request: chat not found',
    );
  });

  it('a 409 body keeps "Conflict" in .message so the poller self-die still matches', async () => {
    globalThis.fetch = mockFetchJson({
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    });
    const api = new TelegramAPI('123:TEST');
    // The exact string poller.ts:100 tests with /Conflict/i must be present.
    await expect(api.getUpdates(0, 1)).rejects.toThrow(/Conflict/i);
  });
});
