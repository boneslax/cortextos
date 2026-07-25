import { describe, it, expect } from 'vitest';
import { classifyOperatorEnv } from '../../../src/daemon/operator-channel';

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
