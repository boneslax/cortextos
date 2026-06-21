import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramAPI } from '../../../src/telegram/api.js';

// Forum-topic support: assert message_thread_id is threaded into outgoing
// payloads when set, and OMITTED when not (so the pre-topics DM/General
// payload stays byte-identical — the backward-compat invariant).

function okResponse() {
  return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as any;
}

describe('TelegramAPI message_thread_id threading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sendMessage includes message_thread_id in the JSON payload when set', async () => {
    let captured: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendMessage(-1001234567890, 'hi', undefined, { messageThreadId: 42 });
    expect(captured.message_thread_id).toBe(42);
    expect(captured.chat_id).toBe(-1001234567890);
  });

  it('sendMessage OMITS message_thread_id when not set (DM/General byte-compat)', async () => {
    let captured: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendMessage(1664028089, 'hi');
    expect('message_thread_id' in captured).toBe(false);
  });

  it('sendChatAction includes message_thread_id when set, omits otherwise', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendChatAction(-100123, 'typing', 7);
    await api.sendChatAction(-100123, 'typing');
    expect(bodies[0].message_thread_id).toBe(7);
    expect('message_thread_id' in bodies[1]).toBe(false);
  });

  it('sendPhoto puts message_thread_id in the multipart FormData when set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgthread-'));
    const img = join(dir, 'p.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let form: FormData | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      form = init.body as FormData;
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendPhoto(-100123, img, 'cap', undefined, 99);
    expect(form?.get('message_thread_id')).toBe('99');
    expect(form?.get('chat_id')).toBe('-100123');
  });

  it('sendPhoto omits message_thread_id from FormData when not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgthread-'));
    const img = join(dir, 'p.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let form: FormData | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      form = init.body as FormData;
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendPhoto(1664028089, img, 'cap');
    expect(form?.get('message_thread_id')).toBeNull();
  });

  it('sendDocument puts message_thread_id in the multipart FormData when set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgthread-'));
    const f = join(dir, 'd.txt');
    writeFileSync(f, 'hello');
    let form: FormData | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      form = init.body as FormData;
      return okResponse();
    }));
    const api = new TelegramAPI('123:abc');
    await api.sendDocument(-100123, f, 'cap', undefined, 55);
    expect(form?.get('message_thread_id')).toBe('55');
  });
});
