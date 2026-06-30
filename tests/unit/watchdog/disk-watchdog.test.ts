import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// disk-watchdog.sh — deterministic host disk monitor. Pages on root-fs use% >= DISK_PAGE_PCT
// OR any /var/log file >= RUNAWAY_GB; >=2-cycle debounce; recovery < DISK_WARN_PCT. Tests use the
// fixture seams (DISK_DF_FIXTURE / DISK_LOGSIZE_FIXTURE) + are STRUCTURALLY unable to send: empty
// framework root (no agent .env → no token), CORTEXTOS_BIN=/nonexistent, dead TELEGRAM_API_BASE.

const SCRIPT = join(__dirname, '../../../bin/disk-watchdog.sh');
let isoFwRoot: string;

beforeAll(() => { isoFwRoot = mkdtempSync(join(tmpdir(), 'dwd-fwroot-')); });

function run(opts: {
  df?: string; logsize?: string; scanDir?: string; dry?: string; ctx?: string; extra?: Record<string, string>;
} = {}): string {
  const ctx = opts.ctx ?? mkdtempSync(join(tmpdir(), 'dwd-st-'));
  return execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      CTX_ROOT: ctx,
      DISK_WATCHDOG_DRY_RUN: opts.dry ?? '1',
      // token isolation — a real send is structurally impossible
      CTX_FRAMEWORK_ROOT: isoFwRoot, CORTEXTOS_BIN: '/nonexistent', WATCHDOG_CHAT_ID: '000',
      TELEGRAM_API_BASE: 'http://127.0.0.1:9', SUDO_BIN: '/nonexistent',
      ...(opts.df !== undefined ? { DISK_DF_FIXTURE: opts.df } : {}),
      ...(opts.logsize !== undefined ? { DISK_LOGSIZE_FIXTURE: opts.logsize } : {}),
      ...(opts.scanDir !== undefined ? { DISK_SCAN_DIR: opts.scanDir } : {}),
      ...(opts.extra ?? {}),
    },
    encoding: 'utf-8',
  });
}
const state = () => mkdtempSync(join(tmpdir(), 'dwd-st2-'));
const logOf = (ctx: string) => { const p = join(ctx, 'state/disk-watchdog/watchdog.log'); return existsSync(p) ? readFileSync(p, 'utf-8') : ''; };

describe('disk-watchdog classification', () => {
  it('healthy (18%, small file) → OK', () => {
    expect(run({ df: '18', logsize: '1048576 /var/log/syslog' })).toContain('DECISION=OK');
  });

  it('root use% >= 90 → PAGE', () => {
    const out = run({ df: '92', logsize: '1000 /var/log/x' });
    expect(out).toContain('DECISION=PAGE');
    expect(out).toContain('92%');
  });

  it('runaway file >= 25G at LOW disk% → PAGE early (the 6/30 mode)', () => {
    const out = run({ df: '50', logsize: '30000000000 /var/log/auth.log' });
    expect(out).toContain('DECISION=PAGE');
    expect(out).toContain('runaway file /var/log/auth.log');
  });

  it('warn band (85%, no runaway) → OK, not a page, WARN logged', () => {
    const ctx = state();
    const out = run({ df: '85', logsize: '1000 /var/log/x', ctx });
    expect(out).toContain('DECISION=OK');
    // dry-run still logs the WARN line
    expect(logOf(ctx)).toContain('WARN');
  });

  it('empty SCAN_DIR (find returns nothing) → OK, degrades to df-only, no integer error', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dwd-empty-'));
    const ctx = state();
    const out = run({ df: '50', scanDir: empty, ctx }); // no logsize fixture → real find on empty dir
    expect(out).toContain('DECISION=OK');
    expect(out).toContain('biggest=0G:none');
    // the bug was a `[: : integer expression expected` on the runaway compare
    expect(logOf(ctx)).not.toContain('integer expression');
  });

  it('non-numeric df → FATAL exit, no crash, no decision', () => {
    const out = run({ df: 'N/A', logsize: '1000 /x' });
    expect(out).not.toContain('DECISION=');
  });

  it('garbage logsize fixture → coerced to 0, no page', () => {
    expect(run({ df: '50', logsize: 'garbage-not-a-size' })).toContain('DECISION=OK');
  });
});

describe('disk-watchdog state machine', () => {
  it('debounce: a page fires only on the 2nd consecutive trigger cycle', () => {
    const ctx = state();
    // cycle 1 (non-dry) → pending=1, no marker
    run({ df: '95', logsize: '1000 /x', dry: '0', ctx });
    expect(existsSync(join(ctx, 'state/disk-watchdog/incident.json'))).toBe(false);
    expect(readFileSync(join(ctx, 'state/disk-watchdog/pending'), 'utf-8').trim()).toBe('1');
    // cycle 2 → attempts the page; pending advances to 2 (marker only on send success, which can't happen)
    run({ df: '95', logsize: '1000 /x', dry: '0', ctx });
    expect(readFileSync(join(ctx, 'state/disk-watchdog/pending'), 'utf-8').trim()).toBe('2');
  });

  it('ISOLATION GUARD: a non-dry page NEVER sends (delivery-failed, never "alert sent")', () => {
    const ctx = state();
    run({ df: '95', logsize: '1000 /x', dry: '0', ctx });
    run({ df: '95', logsize: '1000 /x', dry: '0', ctx }); // cycle 2 attempts the send
    const lg = logOf(ctx);
    expect(lg).toContain('ALERT DELIVERY FAILED');
    expect(lg).not.toContain('alert sent');
    expect(existsSync(join(ctx, 'state/disk-watchdog/incident.json'))).toBe(false);
  });

  it('hysteresis: with an active marker, the warn band (85%) does NOT recover (no flap)', () => {
    const ctx = state();
    // seed an active incident marker by hand
    const mdir = join(ctx, 'state/disk-watchdog');
    mkdirSync(mdir, { recursive: true });
    execFileSync('bash', ['-c', `printf '{"since":"x","pct":95}' > "${join(mdir, 'incident.json')}"`]);
    // 85% is below page(90) but >= warn(80): must NOT clear the marker, must NOT recover
    run({ df: '85', logsize: '1000 /x', dry: '0', ctx });
    expect(existsSync(join(mdir, 'incident.json'))).toBe(true); // marker kept
    expect(logOf(ctx)).not.toContain('recovery sent');
  });

  it('recovery: with an active marker, < warn% (80) clears the marker (attempts recovery)', () => {
    const ctx = state();
    const mdir = join(ctx, 'state/disk-watchdog');
    mkdirSync(mdir, { recursive: true });
    execFileSync('bash', ['-c', `printf '{"since":"x","pct":95}' > "${join(mdir, 'incident.json')}"`]);
    // 50% < warn(80) + no runaway → recovery path; send can't succeed (isolated) so marker is KEPT,
    // but the recovery-send was ATTEMPTED — assert it tried (delivery-failed) rather than ignoring.
    run({ df: '50', logsize: '1000 /x', dry: '0', ctx });
    expect(logOf(ctx)).toMatch(/recovery send FAILED|recovery sent/);
  });
});
