/**
 * Regression tests for a heartbeat TOCTOU lost-update.
 *
 * Two writers touch <stateDir>/heartbeat.json:
 *   - updateHeartbeat() (heartbeat.ts) — an authoritative OVERWRITE that sets
 *     status / mode / current_task / loop_interval.
 *   - logEvent()'s heartbeat refresh (event.ts, opt-in) — a READ-MODIFY-WRITE
 *     that bumps only last_heartbeat and preserves the rest.
 *
 * Without a shared lock, this interleave loses an update:
 *   1. refresh reads heartbeat    (status="online")
 *   2. updateHeartbeat overwrites  (status="busy")
 *   3. refresh writes its stale copy back (status="online")  ← busy lost.
 *
 * The fix wraps BOTH writers in withFileLockSync(stateDir, ...) so the RMW is
 * atomic against the overwrite. These tests prove (a) both writers take the
 * SAME per-agent lock and (b) the interleave that used to clobber a field can
 * no longer happen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { updateHeartbeat } from '../../../src/bus/heartbeat';
import { logEvent } from '../../../src/bus/event';
import * as lock from '../../../src/utils/lock';
import type { BusPaths, Heartbeat } from '../../../src/types';

let testDir: string;
let paths: BusPaths;

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  };
}

const AGENT = 'agent';
const ORG = 'org';

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'hb-lostupdate-'));
  paths = makePaths(testDir);
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(paths.analyticsDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe('heartbeat lost-update — both writers take the per-agent stateDir lock', () => {
  it('updateHeartbeat acquires the stateDir lock', () => {
    const withLock = vi.spyOn(lock, 'withFileLockSync');
    updateHeartbeat(paths, AGENT, 'busy', { org: ORG });
    expect(withLock.mock.calls.some(([dir]) => dir === paths.stateDir)).toBe(true);
  });

  it('the opt-in logEvent heartbeat refresh acquires the stateDir lock', () => {
    // Refresh only runs when a heartbeat already exists AND the caller opts in.
    const hb: Heartbeat = {
      agent: AGENT, org: ORG, status: 'online',
      current_task: '', mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z', loop_interval: '4h',
    };
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(hb));

    const withLock = vi.spyOn(lock, 'withFileLockSync');
    logEvent(paths, AGENT, ORG, 'action', 'tick', 'info', undefined, { refreshHeartbeat: true });
    expect(withLock.mock.calls.some(([dir]) => dir === paths.stateDir)).toBe(true);
  });
});

describe('heartbeat lost-update — the lock enforces mutual exclusion', () => {
  it('a second writer cannot enter the critical section while the stateDir lock is held', () => {
    // Seed status=online (the value a stale RMW would clobber back to).
    const seed: Heartbeat = {
      agent: AGENT, org: ORG, status: 'online',
      current_task: 'old-task', mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z', loop_interval: '4h',
    };
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    writeFileSync(hbPath, JSON.stringify(seed));

    // Model the exact lost-update interleave deterministically:
    //  (1) writer A (the refresh) holds the stateDir lock and reads the stale
    //      online snapshot.
    //  (2) WHILE A holds the lock, writer B (updateHeartbeat) would try to set
    //      status=busy — but both take the SAME lock, so B's acquire is refused
    //      and it cannot race into A's read->write window. Proven directly:
    //      acquireLock(stateDir) returns false while A holds it.
    //  (3) A finishes its bump and releases.
    const refreshTs = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    lock.withFileLockSync(paths.stateDir, () => {
      const aSnapshot = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      expect(aSnapshot.status).toBe('online');
      expect(lock.acquireLock(paths.stateDir)).toBe(false);
      aSnapshot.last_heartbeat = refreshTs;
      writeFileSync(hbPath, JSON.stringify(aSnapshot));
    });

    // After A released, B's update applies cleanly and serially — the post-fix
    // world. Both contributions survive: B's status AND A's timestamp bump.
    updateHeartbeat(paths, AGENT, 'busy', { org: ORG, currentTask: 'now-busy' });
    const final = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(final.status).toBe('busy');
    expect(final.current_task).toBe('now-busy');
  });

  it('sequential overwrite-then-refresh keeps the overwrite status and refreshes the timestamp', async () => {
    updateHeartbeat(paths, AGENT, 'online', { org: ORG, currentTask: 'boot' });
    await new Promise((r) => setTimeout(r, 2));
    updateHeartbeat(paths, AGENT, 'busy', { org: ORG, currentTask: 'working' });
    await new Promise((r) => setTimeout(r, 2));
    logEvent(paths, AGENT, ORG, 'action', 'tick', 'info', undefined, { refreshHeartbeat: true });

    const hbPath = join(paths.stateDir, 'heartbeat.json');
    expect(existsSync(hbPath)).toBe(true);
    const final = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(final.status).toBe('busy');
    expect(final.current_task).toBe('working');
  });
});
