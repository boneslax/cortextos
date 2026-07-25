import { describe, it, expect, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// Thin passthrough (PLAN-v3 §5): getChatMember POSTs chat_id + user_id and
// returns the result. The real logic — turning a status into reachable /
// unreachable / inconclusive — lives in the D1 classifier and is tested there.

describe('TelegramAPI.getChatMember', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs chat_id + user_id to getChatMember and returns the result', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return { json: async () => ({ ok: true, result: { status: 'administrator' } }) };
    }) as any;

    const api = new TelegramAPI('8913497784:TEST');
    const res = await api.getChatMember(-1004463276612, 8913497784);

    expect(capturedUrl).toContain('/getChatMember');
    expect(capturedBody).toEqual({ chat_id: -1004463276612, user_id: 8913497784 });
    expect(res.result.status).toBe('administrator');
  });

  it('throws a typed error (error_code readable) on a permanent 400', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    })) as any;

    const api = new TelegramAPI('8913497784:TEST');
    await expect(api.getChatMember(-100999, 8913497784)).rejects.toMatchObject({ error_code: 400 });
  });
});
