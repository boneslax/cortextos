import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../../../src/daemon/agent-manager.js';

// Tests the topic routing-truth: the (chatId, topicId) -> agent registry and
// resolveTopicOwner. The registry is built in a race-free pre-pass over each
// agent's .env (single source of truth), with duplicates failing closed.

let ctxRoot: string;
let fwRoot: string;
let mgr: AgentManager;

function agentDir(name: string, env: Record<string, string>): { name: string; dir: string } {
  const dir = join(fwRoot, 'agents', name);
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(join(dir, '.env'), body, 'utf-8');
  return { name, dir };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'tr-ctx-'));
  fwRoot = mkdtempSync(join(tmpdir(), 'tr-fw-'));
  mgr = new AgentManager('default', ctxRoot, fwRoot, 'vault');
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(fwRoot, { recursive: true, force: true });
});

const GROUP = '-1001234567890';

describe('topic routing registry', () => {
  it('resolves a mapped (chatId, topicId) to its owning agent', () => {
    const agents = [
      agentDir('dev', { CHAT_ID: GROUP, TOPIC_ID: '11' }),
      agentDir('sales', { CHAT_ID: GROUP, TOPIC_ID: '22' }),
    ];
    (mgr as any).buildTopicRegistry(agents);
    expect(mgr.resolveTopicOwner(GROUP, 11)).toBe('dev');
    expect(mgr.resolveTopicOwner(GROUP, 22)).toBe('sales');
  });

  it('returns null for an undefined thread (General / DM)', () => {
    (mgr as any).buildTopicRegistry([agentDir('dev', { CHAT_ID: GROUP, TOPIC_ID: '11' })]);
    expect(mgr.resolveTopicOwner(GROUP, undefined)).toBeNull();
  });

  it('returns null for a set-but-unmapped thread (caller falls back + warns)', () => {
    (mgr as any).buildTopicRegistry([agentDir('dev', { CHAT_ID: GROUP, TOPIC_ID: '11' })]);
    expect(mgr.resolveTopicOwner(GROUP, 999)).toBeNull();
  });

  it('does NOT resolve a matching topic id from a different chat (foreign-chat guard)', () => {
    (mgr as any).buildTopicRegistry([agentDir('dev', { CHAT_ID: GROUP, TOPIC_ID: '11' })]);
    expect(mgr.resolveTopicOwner('-1009999999999', 11)).toBeNull();
  });

  it('fails closed on a duplicate (chatId, topicId): both unmapped', () => {
    const agents = [
      agentDir('dev', { CHAT_ID: GROUP, TOPIC_ID: '11' }),
      agentDir('clone', { CHAT_ID: GROUP, TOPIC_ID: '11' }),
    ];
    (mgr as any).buildTopicRegistry(agents);
    expect(mgr.resolveTopicOwner(GROUP, 11)).toBeNull();
  });

  it('ignores agents with no TOPIC_ID (they own General, not a topic)', () => {
    (mgr as any).buildTopicRegistry([agentDir('orchestrator', { CHAT_ID: GROUP })]);
    expect(mgr.resolveTopicOwner(GROUP, undefined)).toBeNull();
    expect(mgr.resolveTopicOwner(GROUP, 1)).toBeNull();
  });
});
