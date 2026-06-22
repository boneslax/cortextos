import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../../../src/daemon/agent-manager.js';

// Bug 1 (narrow real gap): a topic added to a RUNNING per-agent group's
// config.json after the agent started isn't in the registry. A throttled,
// additive, on-demand refresh picks it up; throttle bounds disk reads.

let ctxRoot: string, fwRoot: string, mgr: AgentManager;
const GROUP = '-1004359011364';

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'tr-ctx-'));
  fwRoot = mkdtempSync(join(tmpdir(), 'tr-fw-'));
  mgr = new AgentManager('default', ctxRoot, fwRoot, 'vault');
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(fwRoot, { recursive: true, force: true });
});

function fakeRunningAgent(name: string, chatId: string, projectTopics: Record<string, string>) {
  const dir = join(fwRoot, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ project_topics: projectTopics }), 'utf-8');
  // Minimal stub entry: refreshTopicsForChat only needs process.getAgentDir() + chatId.
  (mgr as any).agents.set(name, {
    process: { getAgentDir: () => dir },
    checker: {},
    chatId,
    topicId: undefined,
  });
  return dir;
}

describe('refreshTopicsForChat (Bug 1 narrow gap)', () => {
  it('picks up a topic added to the running group config after start', () => {
    fakeRunningAgent('dev', GROUP, { '10': 'beacon' });
    (mgr as any).buildTopicRegistry([]); // registry starts empty (topic 11 not yet known)
    expect(mgr.resolveTopicOwner(GROUP, 11)).toBeNull();

    // Simulate Bones adding topic 11 to config.json after the agent started.
    writeFileSync(join(fwRoot, 'agents', 'dev', 'config.json'), JSON.stringify({ project_topics: { '10': 'beacon', '11': 'auditflow' } }), 'utf-8');

    const ran = (mgr as any).refreshTopicsForChat(GROUP, 1_000_000);
    expect(ran).toBe(true);
    expect(mgr.resolveTopicOwner(GROUP, 11)).toBe('dev');
    expect(mgr.resolveTopicOwner(GROUP, 10)).toBe('dev'); // additive: existing kept
  });

  it('throttles repeat refreshes within the 5s window', () => {
    fakeRunningAgent('dev', GROUP, { '10': 'beacon' });
    expect((mgr as any).refreshTopicsForChat(GROUP, 1_000_000)).toBe(true);
    expect((mgr as any).refreshTopicsForChat(GROUP, 1_000_000 + 4999)).toBe(false); // throttled
    expect((mgr as any).refreshTopicsForChat(GROUP, 1_000_000 + 5001)).toBe(true);  // window passed
  });

  it('returns false when no running agent owns the chat (cannot help not-running case)', () => {
    expect((mgr as any).refreshTopicsForChat('-100999999', 1_000_000)).toBe(false);
  });
});
