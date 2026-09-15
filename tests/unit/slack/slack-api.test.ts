import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackAPI } from '../../../src/slack/api.js';

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function httpError(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) =>
        retryAfter && name.toLowerCase() === 'retry-after' ? retryAfter : null,
    },
    // Transport-level errors are often NOT JSON (proxy HTML, empty bodies) —
    // parsing must never be reached for them.
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  };
}

describe('SlackAPI — transport hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('every call carries an abort signal (bounded timeout — a hung call must not stall the fast-checker loop)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, messages: [], user: {}, user_id: 'U1' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new SlackAPI('xoxb-test');

    await api.postMessage('C1', 'hi');
    await api.getHistory('C1', '0');
    await api.getUserName('U1');
    await api.getUserInfo('U1');
    await api.getBotUserId();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('getHistory surfaces HTTP 429 with the Retry-After value instead of an opaque JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(429, '12')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getHistory('C1', '0')).rejects.toThrow(/rate limited.*429.*retry after 12s/i);
  });

  it('getHistory surfaces a non-OK HTTP status descriptively (5xx/proxy pages are not JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(502)));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getHistory('C1', '0')).rejects.toThrow(/HTTP 502/);
  });

  it('postMessage throws the Slack app-level error on ok:false (HTTP 200)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ ok: false, error: 'channel_not_found' })));
    const api = new SlackAPI('xoxb-test');

    await expect(api.postMessage('C1', 'hi')).rejects.toThrow(/channel_not_found/);
  });

  it('postMessage surfaces HTTP 429 as a rate-limit error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(429, '30')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.postMessage('C1', 'hi')).rejects.toThrow(/rate limited/i);
  });

  it('getUserInfo never throws: HTTP failure -> null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(500)));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getUserInfo('U1')).resolves.toBeNull();
  });

  it('getBotUserId never throws: network rejection -> null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getBotUserId()).resolves.toBeNull();
  });

  it('getUserName never throws: rejection -> falls back to the user id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getUserName('U42')).resolves.toBe('U42');
  });

  it('getHistory returns newest-last (reversed) on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          ok: true,
          messages: [
            { ts: '2.0', type: 'message', text: 'newest' },
            { ts: '1.0', type: 'message', text: 'oldest' },
          ],
        }),
      ),
    );
    const api = new SlackAPI('xoxb-test');

    const messages = await api.getHistory('C1', '0');
    expect(messages.map((m) => m.ts)).toEqual(['1.0', '2.0']);
  });
});
