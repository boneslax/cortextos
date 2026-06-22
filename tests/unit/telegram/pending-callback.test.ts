import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordPendingCallback, resolvePendingCallback, clearPendingCallback } from '../../../src/telegram/pending-callback.js';

let ctxRoot: string;
beforeEach(() => { ctxRoot = mkdtempSync(join(tmpdir(), 'pcb-')); });
afterEach(() => { rmSync(ctxRoot, { recursive: true, force: true }); });

describe('pending-callback index', () => {
  it('records then resolves an owner by id', () => {
    recordPendingCallback(ctxRoot, 'abc123', 'dev-delegate');
    expect(resolvePendingCallback(ctxRoot, 'abc123')).toBe('dev-delegate');
  });

  it('returns null for an unknown id', () => {
    expect(resolvePendingCallback(ctxRoot, 'nope')).toBeNull();
  });

  it('clear removes the entry', () => {
    recordPendingCallback(ctxRoot, 'abc123', 'dev-delegate');
    clearPendingCallback(ctxRoot, 'abc123');
    expect(resolvePendingCallback(ctxRoot, 'abc123')).toBeNull();
  });

  it('sanitizes the id so it cannot escape the pending-callbacks dir', () => {
    recordPendingCallback(ctxRoot, '../../etc/passwd', 'x');
    // The traversal chars are stripped; nothing is written outside the dir.
    expect(existsSync(join(ctxRoot, 'etc', 'passwd'))).toBe(false);
  });

  it('clear sweeps entries older than the TTL', () => {
    recordPendingCallback(ctxRoot, 'stale', 'a');
    recordPendingCallback(ctxRoot, 'fresh', 'b');
    // Backdate 'stale' two hours.
    const old = Date.now() / 1000 - 2 * 3600;
    utimesSync(join(ctxRoot, 'state', 'pending-callbacks', 'stale'), old, old);
    clearPendingCallback(ctxRoot, 'unrelated'); // triggers the sweep
    expect(resolvePendingCallback(ctxRoot, 'stale')).toBeNull();
    expect(resolvePendingCallback(ctxRoot, 'fresh')).toBe('b');
  });
});
