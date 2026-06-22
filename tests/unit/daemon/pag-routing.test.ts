import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../../../src/daemon/agent-manager.js';

// v2 per-agent-group: each project topic in an agent's OWN group must register
// to that agent, so the agent's own topic callbacks resolve to self (never
// dropped) and inbound self-routes.

let ctxRoot: string, fwRoot: string, mgr: AgentManager;

function agentDir(name: string, env: Record<string, string>): { name: string; dir: string } {
  const dir = join(fwRoot, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf-8');
  return { name, dir };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'pag-ctx-'));
  fwRoot = mkdtempSync(join(tmpdir(), 'pag-fw-'));
  mgr = new AgentManager('default', ctxRoot, fwRoot, 'vault');
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(fwRoot, { recursive: true, force: true });
});

const DEV = '-1004422760205';

describe('PAG topic registry (project_topics)', () => {
  it('registers EVERY project topic in the agent group to that agent', () => {
    const a = agentDir('dev', { CHAT_ID: DEV, TOPIC_ID: '2' });
    (mgr as any).buildTopicRegistry([{ ...a, config: { project_topics: { '2': 'standup', '34': 'auditflow', '35': 'hub' } } }]);
    expect(mgr.resolveTopicOwner(DEV, 2)).toBe('dev');
    expect(mgr.resolveTopicOwner(DEV, 34)).toBe('dev');
    expect(mgr.resolveTopicOwner(DEV, 35)).toBe('dev');
  });

  it('registers project topics even when .env has no single TOPIC_ID', () => {
    const a = agentDir('sales', { CHAT_ID: '-100999' });
    (mgr as any).buildTopicRegistry([{ ...a, config: { project_topics: { '7': 'acme-deal' } } }]);
    expect(mgr.resolveTopicOwner('-100999', 7)).toBe('sales');
  });

  it('distinct group CHAT_IDs never collide on the same topic id', () => {
    const dev = agentDir('dev', { CHAT_ID: DEV });
    const sales = agentDir('sales', { CHAT_ID: '-100999' });
    (mgr as any).buildTopicRegistry([
      { ...dev, config: { project_topics: { '11': 'a' } } },
      { ...sales, config: { project_topics: { '11': 'b' } } },
    ]);
    // same topic id 11 in different groups → different keys, no collision
    expect(mgr.resolveTopicOwner(DEV, 11)).toBe('dev');
    expect(mgr.resolveTopicOwner('-100999', 11)).toBe('sales');
  });

  it('a topic NOT in project_topics resolves to null (fallback, not mis-route)', () => {
    const a = agentDir('dev', { CHAT_ID: DEV });
    (mgr as any).buildTopicRegistry([{ ...a, config: { project_topics: { '2': 'standup' } } }]);
    expect(mgr.resolveTopicOwner(DEV, 999)).toBeNull();
  });

  it('same (group, topic) owned by two agents fails closed (both unmapped)', () => {
    const dev = agentDir('dev', { CHAT_ID: DEV });
    const clone = agentDir('clone', { CHAT_ID: DEV });
    (mgr as any).buildTopicRegistry([
      { ...dev, config: { project_topics: { '2': 'standup' } } },
      { ...clone, config: { project_topics: { '2': 'dup' } } },
    ]);
    expect(mgr.resolveTopicOwner(DEV, 2)).toBeNull();
  });

  it('dynamic upsert with TOPIC_ID==a project_topics key cannot resurrect a cross-owner collision [CB1]', () => {
    const dev = agentDir('dev', { CHAT_ID: DEV });
    (mgr as any).buildTopicRegistry([{ ...dev, config: { project_topics: { '2': 'standup' } } }]);
    expect(mgr.resolveTopicOwner(DEV, 2)).toBe('dev');
    // Agent B dynamically starts claiming the same (group, topic 2), with its
    // .env TOPIC_ID=2 ALSO present in project_topics. Must stay unmapped, not B.
    (mgr as any).upsertTopicRegistry('intruder', DEV, 2, { project_topics: { '2': 'poach' } });
    expect(mgr.resolveTopicOwner(DEV, 2)).toBeNull();
  });
});
