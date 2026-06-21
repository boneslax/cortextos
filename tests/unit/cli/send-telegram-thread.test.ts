/**
 * Forum-topic support: `cortextos bus send-telegram --thread <id>` must pass
 * message_thread_id to the API, with precedence
 *   --thread flag > TOPIC_ID (.env) > process.env.TOPIC_ID > none.
 * Image/document sends thread via the 5th positional arg (FormData path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const sendPhotoSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const sendDocumentSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) { return sendMessageSpy(...args); }
    sendPhoto(...args: unknown[]) { return sendPhotoSpy(...args); }
    sendDocument(...args: unknown[]) { return sendDocumentSpy(...args); }
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
const saved: Record<string, string | undefined> = {};
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'thr-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'thr-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
  for (const k of ['CTX_ROOT', 'CTX_AGENT_NAME', 'BOT_TOKEN', 'TOPIC_ID']) saved[k] = process.env[k];
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  delete process.env.TOPIC_ID;
  process.chdir(tempCwd);
  sendMessageSpy.mockClear(); sendPhotoSpy.mockClear(); sendDocumentSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const k of ['CTX_ROOT', 'CTX_AGENT_NAME', 'BOT_TOKEN', 'TOPIC_ID']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

function optsArg() { return sendMessageSpy.mock.calls[0][3] as { messageThreadId?: number }; }

describe('send-telegram --thread (forum topics)', () => {
  it('passes --thread as messageThreadId to sendMessage', async () => {
    await busCommand.parseAsync(['send-telegram', '-100123', 'hi', '--thread', '42'], { from: 'user' });
    expect(optsArg().messageThreadId).toBe(42);
  });

  it('falls back to process.env.TOPIC_ID when no --thread', async () => {
    process.env.TOPIC_ID = '77';
    await busCommand.parseAsync(['send-telegram', '-100123', 'hi'], { from: 'user' });
    expect(optsArg().messageThreadId).toBe(77);
  });

  it('--thread overrides TOPIC_ID env', async () => {
    process.env.TOPIC_ID = '77';
    await busCommand.parseAsync(['send-telegram', '-100123', 'hi', '--thread', '42'], { from: 'user' });
    expect(optsArg().messageThreadId).toBe(42);
  });

  it('no thread anywhere → messageThreadId undefined (DM/General unchanged)', async () => {
    await busCommand.parseAsync(['send-telegram', '1664028089', 'hi'], { from: 'user' });
    expect(optsArg().messageThreadId).toBeUndefined();
  });

  it('non-numeric thread value is ignored (treated as no thread)', async () => {
    await busCommand.parseAsync(['send-telegram', '-100123', 'hi', '--thread', 'General'], { from: 'user' });
    expect(optsArg().messageThreadId).toBeUndefined();
  });

  it('image send threads via the 5th positional arg', async () => {
    const img = join(tempCwd, 'p.png');
    writeFileSync(img, Buffer.from([0x89, 0x50]));
    await busCommand.parseAsync(['send-telegram', '-100123', 'cap', '--image', img, '--thread', '9'], { from: 'user' });
    expect(sendPhotoSpy.mock.calls[0][4]).toBe(9);
  });

  it('document send threads via the 5th positional arg', async () => {
    const f = join(tempCwd, 'd.txt');
    writeFileSync(f, 'x');
    await busCommand.parseAsync(['send-telegram', '-100123', 'cap', '--file', f, '--thread', '9'], { from: 'user' });
    expect(sendDocumentSpy.mock.calls[0][4]).toBe(9);
  });
});
