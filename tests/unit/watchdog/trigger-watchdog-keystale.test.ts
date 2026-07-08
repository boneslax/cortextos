import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// BLIND-RISK key-refresh-staleness self-alert for bin/trigger-watchdog.sh (now LIVE —
// deployed via atomic swap after Codex+GLM gate).
//
// Gap it closes (watcher-unwatched, 2026-07-07): op key-refresh can fail for hours → get_key
// serves a last-good STALE cached key → Trigger reads go UNKNOWN — while the watchdog says NOTHING.
// The check watches its OWN read path: the OLDEST keycache mtime (get_key writes ONLY on a
// successful op-fetch, so mtime = last successful refresh). A PRESENT-but-stale cache fires at the
// fixed 3h floor immediately. A MISSING cache is graced (WATCHDOG_KEY_MISSING_GRACE_SEC) so a
// routine key rotation (401 → bust deletes the cache mid-loop → re-fetch repopulates it next tick)
// never false-fires; only a persistently-missing cache (op can't re-fetch) counts as blind.
//
// STRUCTURAL ISOLATION (the false-page lesson): every run is incapable of reaching a live token
// or Telegram — empty CTX_FRAMEWORK_ROOT (no agent .env → no BOT_TOKEN), OP_SA_TOKEN_FILE and
// CORTEXTOS_BIN=/nonexistent, and TELEGRAM_API_BASE at a dead localhost endpoint. The ISOLATION
// GUARD test asserts the alert path resolves to "ALERT DELIVERY FAILED" — never an actual send.

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');
const FIELDS = ['hubapp_prod_read_key', 'helpdesk_prod_read_key'];
let isoFwRoot: string;

beforeAll(() => {
  // empty framework root → CTX_AGENT_DIR/.env does not exist → no token is ever resolved.
  isoFwRoot = mkdtempSync(join(tmpdir(), 'wdks-fwroot-'));
});

// Seed a state dir + keycache, run `check_key_refresh_staleness` under the WATCHDOG_LIB_ONLY seam,
// and return { out, log, state, marker }. `ages` maps a field → seconds-since-last-refresh
// (undefined field = MISSING cache file). `missingSince` maps a field → seconds-ago for that field's
// first-seen-missing marker (simulates accrued missing time). `markerAge` seeds the blind-risk
// rate-limit marker (seconds ago).
function runCheck(opts: {
  ages?: Partial<Record<string, number>>;
  missingSince?: Partial<Record<string, number>>;
  markerAge?: number;
  dry?: string;
  extra?: Record<string, string>;
} = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wdks-st-'));
  const wdDir = join(state, 'state/trigger-watchdog');
  const kc = join(wdDir, 'keycache');
  mkdirSync(kc, { recursive: true });
  const now = Date.now();
  const seedMtime = (p: string, secAgo: number) => { const t = new Date(now - secAgo * 1000); utimesSync(p, t, t); };

  const ages = opts.ages ?? { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 };
  for (const f of FIELDS) {
    const secAgo = ages[f];
    if (secAgo === undefined) continue; // leave the cache file MISSING
    const p = join(kc, `${f}.key`);
    writeFileSync(p, 'tr_prod_SEEDED');
    seedMtime(p, secAgo);
  }
  const missingSince = opts.missingSince ?? {};
  for (const f of FIELDS) {
    const secAgo = missingSince[f];
    if (secAgo === undefined) continue;
    const p = join(wdDir, `keymissing.${f}.since`);
    writeFileSync(p, '');
    seedMtime(p, secAgo);
  }
  const marker = join(wdDir, 'keystale-alerted.marker');
  if (opts.markerAge !== undefined) { writeFileSync(marker, ''); seedMtime(marker, opts.markerAge); }

  const out = execFileSync('bash', ['-c', `source "${SCRIPT}"; check_key_refresh_staleness`], {
    env: {
      ...process.env,
      WATCHDOG_LIB_ONLY: '1',
      CTX_ROOT: state,
      WATCHDOG_DRY_RUN: opts.dry ?? '1',
      // structural send-isolation — a real Telegram send is impossible from a test:
      CTX_FRAMEWORK_ROOT: isoFwRoot,     // no agent .env → no BOT_TOKEN
      CORTEXTOS_BIN: '/nonexistent',     // bus CLI can't run
      OP_SA_TOKEN_FILE: '/nonexistent',  // no 1Password token
      TELEGRAM_API_BASE: 'http://127.0.0.1:9', // raw-curl fallback points at a dead endpoint
      WATCHDOG_CHAT_ID: '000',
      ...(opts.extra ?? {}),
    },
    encoding: 'utf-8',
  });
  const logPath = join(wdDir, 'watchdog.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const missMarker = (f: string) => join(wdDir, `keymissing.${f}.since`);
  return { out: out.trim(), log, state, marker, missMarker };
}

describe('trigger-watchdog BLIND-RISK key-refresh-staleness self-alert', () => {
  // ---- present-but-stale (the original op-failing-for-days scenario) — UNCHANGED by the grace fix ----
  it('fresh cache (both keys just refreshed) → OK, no alert decision', () => {
    const r = runCheck({ ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 } });
    expect(r.out).toContain('KEYSTALE_DECISION=OK');
    expect(r.out).not.toContain('ALERT');
    expect(r.log).toContain('read-path fresh');
  });

  // Design-point proof: a 90-min-old cache is PAST KEY_TTL (1h) but UNDER the 3h floor → still OK.
  it('cache older than KEY_TTL(1h) but under the 3h floor (90m) → OK (floor > TTL)', () => {
    const r = runCheck({ ages: { hubapp_prod_read_key: 90 * 60, helpdesk_prod_read_key: 30 * 60 } });
    expect(r.out).toContain('KEYSTALE_DECISION=OK');
  });

  it('present-but-stale (oldest 4h > 3h floor) → ALERT immediately (no grace on a present cache)', () => {
    const r = runCheck({ ages: { hubapp_prod_read_key: 4 * 3600, helpdesk_prod_read_key: 2 * 3600 } });
    expect(r.out).toContain('KEYSTALE_DECISION=ALERT');
    expect(r.out).toContain('ageSec=14400'); // the OLDEST (4h) drives the signal
  });

  it('present-but-stale 55h (op failing for days) → fires IMMEDIATELY, no grace delay', () => {
    const r = runCheck({ ages: { hubapp_prod_read_key: 55 * 3600, helpdesk_prod_read_key: 55 * 3600 } });
    expect(r.out).toContain('KEYSTALE_DECISION=ALERT');
    expect(r.out).toContain('ageSec=198000'); // 55h in seconds — age of the last successful refresh
  });

  // ---- MISSING-cache GRACE (kills the routine-rotation false positive) ----
  it('missing cache < grace (60s missing, 30m grace) → NO alert (a transient rotation-bust)', () => {
    const r = runCheck({
      ages: { helpdesk_prod_read_key: 0 },          // hubapp cache absent
      missingSince: { hubapp_prod_read_key: 60 },   // first seen missing 60s ago
    });
    expect(r.out).toContain('KEYSTALE_DECISION=OK');
    expect(r.out).not.toContain('ALERT');
  });

  it('missing cache first-seen this tick (no marker yet) → NO alert, accrual marker written', () => {
    // non-dry so the first-seen-missing marker actually gets written (accrual begins)
    const r = runCheck({ ages: { helpdesk_prod_read_key: 0 }, dry: '0' });
    expect(r.log).toContain('read-path fresh'); // oldest age is 0 (within grace) → not degraded
    expect(existsSync(r.missMarker('hubapp_prod_read_key'))).toBe(true); // accrual marker created
    expect(r.log).not.toContain('ALERT DELIVERY FAILED'); // no send attempted
  });

  it('missing cache > grace (40m missing, 30m grace) → ALERT (persistent op-fetch failure = blind)', () => {
    const r = runCheck({
      ages: { helpdesk_prod_read_key: 0 },
      missingSince: { hubapp_prod_read_key: 40 * 60 }, // missing 40m > 30m grace
    });
    expect(r.out).toContain('KEYSTALE_DECISION=ALERT');
    expect(r.out).toContain('ageSec=999999999'); // maximally stale once grace elapses
  });

  it('bust-then-present next tick → missing-since marker CLEARED, NO alert (rotation self-healed)', () => {
    // cache is back (fresh) but a stale missing-since marker lingers from the bust tick; the present
    // branch must clear it so it never accrues, and the decision is a clean OK.
    const r = runCheck({
      ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 },
      missingSince: { hubapp_prod_read_key: 40 * 60 }, // would be "blind" IF still missing
      dry: '0',
    });
    expect(existsSync(r.missMarker('hubapp_prod_read_key'))).toBe(false); // cleared on re-fetch
    expect(r.log).toContain('read-path fresh');
    expect(r.log).not.toContain('ALERT DELIVERY FAILED'); // no alert fired
  });

  // ---- rate-limit ----
  it('stale + recent alert marker (1h ago < 6h re-alert window) → SUPPRESSED, no re-alert', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 4 * 3600, helpdesk_prod_read_key: 4 * 3600 },
      markerAge: 3600,
    });
    expect(r.out).toContain('KEYSTALE_DECISION=SUPPRESSED');
    expect(r.out).not.toContain('KEYSTALE_DECISION=ALERT');
    expect(r.log).toContain('re-alert suppressed');
  });

  it('stale + stale alert marker (7h ago > 6h window) → re-alerts (send attempted)', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 8 * 3600, helpdesk_prod_read_key: 8 * 3600 },
      markerAge: 7 * 3600,
      dry: '0',
    });
    expect(r.log).not.toContain('re-alert suppressed');
    expect(r.log).toContain('BLIND-RISK alert send FAILED'); // it tried, isolation blocked the send
  });

  // ---- recovery (FIX #3: announce resolution, symmetric with the prod-stall recovery) ----
  it('recovery: fresh cache + pre-seeded alert marker → SENDS recovery, clears marker (once)', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 },
      markerAge: 10 * 3600,
      dry: '0',
    });
    expect(existsSync(r.marker)).toBe(false);              // marker cleared → future degradation re-alerts
    expect(r.log).toContain('read-path RECOVERED');
    expect(r.log).toContain('sent recovery + cleared blind-risk marker');
    // the recovery send was ATTEMPTED but isolation blocked it — never an actual send
    expect(r.log).toContain('ALERT DELIVERY FAILED');
    expect(r.log).not.toContain('alert sent');
  });

  it('never-degraded steady state (fresh, no alert marker) → SILENT (no recovery send)', () => {
    const r = runCheck({ ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 }, dry: '0' });
    expect(r.log).toContain('read-path fresh');
    expect(r.log).not.toContain('RECOVERED');
    expect(r.log).not.toContain('ALERT DELIVERY FAILED'); // no send of any kind attempted
  });

  // ---- ISOLATION GUARD — a real (non-dry) blind-risk alert NEVER sends ----
  it('ISOLATION GUARD: a non-dry blind-risk alert resolves to delivery-failed, no send, no marker', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 5 * 3600, helpdesk_prod_read_key: 5 * 3600 },
      dry: '0',
    });
    expect(r.log).toContain('ALERT DELIVERY FAILED');
    expect(r.log).not.toContain('alert sent'); // never "alert sent via bus CLI" / "via raw-curl fallback"
    expect(r.log).toContain('BLIND-RISK alert send FAILED');
    expect(existsSync(r.marker)).toBe(false);  // send failed → marker not written (retries next tick)
  });

  // ---- tunables + validation ----
  it('WATCHDOG_KEY_STALE_ALERT_SEC honored: a 5m cache alerts under a 60s override', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 300, helpdesk_prod_read_key: 300 },
      extra: { WATCHDOG_KEY_STALE_ALERT_SEC: '60' },
    });
    expect(r.out).toContain('KEYSTALE_DECISION=ALERT');
    expect(r.out).toContain('thresholdSec=60');
  });

  it('WATCHDOG_KEY_MISSING_GRACE_SEC honored: 60s-missing alerts under a 30s grace override', () => {
    const r = runCheck({
      ages: { helpdesk_prod_read_key: 0 },
      missingSince: { hubapp_prod_read_key: 60 }, // 60s missing
      extra: { WATCHDOG_KEY_MISSING_GRACE_SEC: '30' },
    });
    expect(r.out).toContain('KEYSTALE_DECISION=ALERT');
  });

  it('validation: a non-numeric WATCHDOG_KEY_STALE_ALERT_SEC falls back to the 10800 default + logs WARN', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 },
      extra: { WATCHDOG_KEY_STALE_ALERT_SEC: 'abc' },
    });
    expect(r.out).toContain('thresholdSec=10800');
    expect(r.log).toContain("WARN: WATCHDOG_KEY_STALE_ALERT_SEC='abc' is not a positive integer");
  });

  it('validation: a garbage WATCHDOG_KEY_MISSING_GRACE_SEC falls back to 1800 (missing still graced)', () => {
    // grace=garbage → 1800; a 60s-missing cache is within the default grace → NO alert
    const r = runCheck({
      ages: { helpdesk_prod_read_key: 0 },
      missingSince: { hubapp_prod_read_key: 60 },
      extra: { WATCHDOG_KEY_MISSING_GRACE_SEC: 'abc' },
    });
    expect(r.out).toContain('KEYSTALE_DECISION=OK');
    expect(r.log).toContain("WARN: WATCHDOG_KEY_MISSING_GRACE_SEC='abc' is not a positive integer");
  });

  it('validation: a zero/negative WATCHDOG_KEY_STALE_ALERT_SEC falls back to 10800', () => {
    const r = runCheck({
      ages: { hubapp_prod_read_key: 0, helpdesk_prod_read_key: 0 },
      extra: { WATCHDOG_KEY_STALE_ALERT_SEC: '0' },
    });
    expect(r.out).toContain('thresholdSec=10800');
    expect(r.log).toContain('must be > 0');
  });
});
