import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Layer-1b IMPACT classification for bin/trigger-watchdog.sh. The trigger is "his
// prod runs are stalled" (0 EXECUTING + aging QUEUED + nothing COMPLETED recently),
// NOT "any status component is down". Critically, a momentary 0-EXECUTING snapshot
// with a recent completion must NOT page (the false-positive the 1a over-page taught us).

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');
let dir: string;
const iso = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString();
const f = (name: string, obj: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p; };

// healthy helpdesk fixtures (so only hubapp varies) + a /dev/null status fixture
let hExec: string, hQ: string, hDone: string, emptyExec: string, oldQ: string, oldDone: string, freshQ: string, recentDone: string;
// Empty framework root → the script derives CTX_AGENT_DIR=<here>/orgs/vault/agents/solo
// which has NO .env, so no BOT_TOKEN is ever resolved and send_alert can't reach a real
// token. Combined with CORTEXTOS_BIN=/nonexistent, tests NEVER send a real Telegram.
let isoFwRoot: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wd1b-'));
  isoFwRoot = mkdtempSync(join(tmpdir(), 'wd1b-fwroot-'));
  hExec = f('hexec.json', { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  hQ = f('hq.json', { data: [{ createdAt: iso(20) }] });
  hDone = f('hdone.json', { data: [{ finishedAt: iso(15) }] });
  emptyExec = f('empty.json', { data: [] });
  oldQ = f('oldq.json', { data: [{ createdAt: iso(20 * 60) }] });      // 20m old queued
  oldDone = f('olddone.json', { data: [{ finishedAt: iso(30 * 60) }] }); // 30m since completion
  freshQ = f('freshq.json', { data: [{ createdAt: iso(30) }] });
  recentDone = f('recentdone.json', { data: [{ finishedAt: iso(20) }] });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(state: string, hubExec: string, hubQ: string, hubDone: string, dry = '1'): string {
  return execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env, CTX_ROOT: state, WATCHDOG_DRY_RUN: dry, WATCHDOG_STATUS_FIXTURE: '/dev/null',
      // token isolation — make a real send STRUCTURALLY impossible from a test:
      // empty framework root (no agent .env → no BOT_TOKEN), no cortextos bin,
      // no 1Password token, dummy chat, AND the raw-curl endpoint pointed at a
      // dead localhost URL (belt-and-suspenders even if a token leaked).
      CTX_FRAMEWORK_ROOT: isoFwRoot, CORTEXTOS_BIN: '/nonexistent', WATCHDOG_CHAT_ID: '000',
      OP_SA_TOKEN_FILE: '/nonexistent', TELEGRAM_API_BASE: 'http://127.0.0.1:9',
      WATCHDOG_RUNS_FIXTURE_helpdesk_EXECUTING: hExec, WATCHDOG_RUNS_FIXTURE_helpdesk_QUEUED: hQ, WATCHDOG_RUNS_FIXTURE_helpdesk_COMPLETED: hDone,
      WATCHDOG_RUNS_FIXTURE_hubapp_EXECUTING: hubExec, WATCHDOG_RUNS_FIXTURE_hubapp_QUEUED: hubQ, WATCHDOG_RUNS_FIXTURE_hubapp_COMPLETED: hubDone,
    },
    encoding: 'utf-8',
  });
}
const state = () => mkdtempSync(join(tmpdir(), 'wd1b-st-'));

describe('trigger-watchdog 1b impact classification', () => {
  it('healthy prod (executing + fresh) → OK', () => {
    expect(run(state(), hExec, freshQ, recentDone)).toContain('DECISION=OK');
  });
  it('true stall (0 exec + aging queued + stale completion) → PAGE', () => {
    const out = run(state(), emptyExec, oldQ, oldDone);
    expect(out).toContain('DECISION=PAGE');
    expect(out).toContain('hubapp');
  });
  it('momentary 0-exec WITH a recent completion → OK (not a stall)', () => {
    expect(run(state(), emptyExec, freshQ, recentDone)).toContain('DECISION=OK');
  });
  it('0-exec + aging queued but a RECENT completion → OK (still draining)', () => {
    expect(run(state(), emptyExec, oldQ, recentDone)).toContain('DECISION=OK');
  });

  it('debounce: stall pages only on the 2nd consecutive cycle', () => {
    const st = state();
    // cycle 1 (non-dry; send fails w/o token but state logic runs) → pending, no marker
    run(st, emptyExec, oldQ, oldDone, '0');
    expect(existsSync(join(st, 'state/trigger-watchdog/incident.hubapp.json'))).toBe(false);
    expect(readFileSync(join(st, 'state/trigger-watchdog/pending.hubapp'), 'utf-8').trim()).toBe('1');
    // cycle 2 → attempts the page (send fails → marker only written on success, so still none,
    // but pending advances to 2 = past the debounce gate). Assert the debounce counted.
    run(st, emptyExec, oldQ, oldDone, '0');
    expect(readFileSync(join(st, 'state/trigger-watchdog/pending.hubapp'), 'utf-8').trim()).toBe('2');
  });

  it('ISOLATION GUARD: a non-dry stall NEVER makes a real send (log shows delivery-failed, never "alert sent")', () => {
    const st = state();
    run(st, emptyExec, oldQ, oldDone, '0');
    run(st, emptyExec, oldQ, oldDone, '0'); // cycle 2 attempts the send
    const logTxt = readFileSync(join(st, 'state/trigger-watchdog/watchdog.log'), 'utf-8');
    expect(logTxt).toContain('ALERT DELIVERY FAILED');   // it tried…
    expect(logTxt).not.toContain('alert sent');          // …and provably could NOT reach a live endpoint
    // and no marker was written (send never succeeded), so nothing was "delivered"
    expect(existsSync(join(st, 'state/trigger-watchdog/incident.hubapp.json'))).toBe(false);
  });
});
