import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { classifyOperatorEnv, resolveOperatorCreds } from '../../../src/daemon/operator-channel';

// PLAN-v3 §10 precondition 2. Partial config is worse than none: a chat id with
// no valid token gets cross-wired to an agent bot and fails silently. Half-set
// must be a hard 'partial' error, never a fall-through.

describe('classifyOperatorEnv — partial-config guard', () => {
  it('both set + valid token => complete', () => {
    const r = classifyOperatorEnv('1664028089', '8913497784:AAExampleToken_-');
    expect(r).toEqual({ kind: 'complete', chatId: '1664028089', botToken: '8913497784:AAExampleToken_-' });
  });

  it('neither set => absent', () => {
    expect(classifyOperatorEnv(undefined, undefined)).toEqual({ kind: 'absent' });
    expect(classifyOperatorEnv('', '')).toEqual({ kind: 'absent' });
  });

  it('DANGEROUS CASE: chat id set, token missing => partial (NOT absent, NOT complete)', () => {
    const r = classifyOperatorEnv('1664028089', undefined);
    expect(r.kind).toBe('partial');
  });

  it('token set, chat id missing => partial', () => {
    const r = classifyOperatorEnv(undefined, '8913497784:AAExampleToken_-');
    expect(r.kind).toBe('partial');
  });

  it('both set but token malformed => partial (validate BOTH)', () => {
    const r = classifyOperatorEnv('1664028089', 'not-a-token');
    expect(r.kind).toBe('partial');
  });
});

describe('resolveOperatorCreds — priority + fallback (injectable env)', () => {
  const OP = { CTX_OPERATOR_CHAT_ID: '999', CTX_OPERATOR_BOT_TOKEN: '5550001:AAToken_-' };

  it('complete CTX_OPERATOR => use it (never the fallback)', () => {
    const r = resolveOperatorCreds('/nonexistent', OP as any);
    expect(r).toEqual({ ok: true, creds: { chatId: '999', botToken: '5550001:AAToken_-' } });
  });

  it('partial CTX_OPERATOR => refuse (ok:false partial), no fallback even if allowed', () => {
    const r = resolveOperatorCreds('/nonexistent', { CTX_OPERATOR_CHAT_ID: '999' } as any, { allowAgentFallback: true });
    expect(r).toMatchObject({ ok: false, reason: 'partial' });
  });

  it('absent + liveness (allowAgentFallback:false) => ok:false absent (operator channel required)', () => {
    const r = resolveOperatorCreds('/nonexistent', {} as any, { allowAgentFallback: false });
    expect(r).toEqual({ ok: false, reason: 'absent' });
  });

  describe('absent + fallback allowed => first agent .env (coherent pair)', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'opfallback-'));
      const agentDir = join(root, 'orgs', 'vault', 'agents', 'seo');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN=7770001:AAAgentTok_-\nCHAT_ID=-100123\n');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('pairs the agent chat with the agent token (deliverable)', () => {
      const r = resolveOperatorCreds(root, {} as any, { allowAgentFallback: true });
      expect(r).toEqual({ ok: true, creds: { chatId: '-100123', botToken: '7770001:AAAgentTok_-' } });
    });

    it('but a partial CTX_OPERATOR still refuses rather than falling back', () => {
      const r = resolveOperatorCreds(root, { CTX_OPERATOR_BOT_TOKEN: '5550001:AAT_-' } as any, { allowAgentFallback: true });
      expect(r).toMatchObject({ ok: false, reason: 'partial' });
    });
  });
});
