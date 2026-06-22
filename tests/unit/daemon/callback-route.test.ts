import { describe, it, expect } from 'vitest';
import { decideCallbackRoute } from '../../../src/daemon/agent-manager.js';

// Safety matrix for inline-button callback routing under forum topics.
// Ask callbacks (askopt/asktoggle/asksubmit) replay as PTY keystrokes, so an
// unresolved one must NEVER run on a guessed/orchestrator PTY.

const ORCH = 'orchestrator';

describe('decideCallbackRoute', () => {
  it('General (no thread), no owner → orchestrator self (its own prompt)', () => {
    expect(decideCallbackRoute({ isAsk: true, threadPresent: false, owner: null, selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'self' });
    expect(decideCallbackRoute({ isAsk: false, threadPresent: false, owner: null, selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'self' });
  });

  it('thread present but unresolved + ASK → drop (fail closed, no stray keystrokes)', () => {
    expect(decideCallbackRoute({ isAsk: true, threadPresent: true, owner: null, selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'drop' });
  });

  it('thread present but unresolved + perm/restart → orchestrator (stray file is harmless)', () => {
    expect(decideCallbackRoute({ isAsk: false, threadPresent: true, owner: null, selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'self' });
  });

  it('owner is the orchestrator itself → self', () => {
    expect(decideCallbackRoute({ isAsk: true, threadPresent: true, owner: ORCH, selfName: ORCH, ownerRunning: true }))
      .toEqual({ action: 'self' });
  });

  it('owner is another RUNNING agent → route to that agent', () => {
    expect(decideCallbackRoute({ isAsk: true, threadPresent: true, owner: 'dev', selfName: ORCH, ownerRunning: true }))
      .toEqual({ action: 'agent', owner: 'dev' });
  });

  it('owner resolved but NOT running → drop (never mis-route to orchestrator)', () => {
    expect(decideCallbackRoute({ isAsk: true, threadPresent: true, owner: 'dev', selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'drop' });
    expect(decideCallbackRoute({ isAsk: false, threadPresent: true, owner: 'dev', selfName: ORCH, ownerRunning: false }))
      .toEqual({ action: 'drop' });
  });
});
