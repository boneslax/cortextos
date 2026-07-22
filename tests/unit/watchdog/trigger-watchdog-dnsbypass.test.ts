import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Tier-3 DNS-bypass cached-IP alert fallback for bin/trigger-watchdog.sh (now LIVE —
// deployed via atomic swap after Codex+GLM gate).
//
// Gap it closes (2026-07-07): a link-up-but-DNS-flaky window (a flapping WiFi NIC) took the resolver
// and BOTH existing send tiers (bus CLI + raw-curl) down together, so a BLIND-RISK / prod-stall alert
// fired but could NOT be delivered — the alert rode the exact resolver that was broken. Tier 3 retries
// the SAME send pinned to a cached last-good IP via `curl --resolve <host>:443:<ip>`, bypassing DNS,
// while keeping FULL TLS cert validation for the API host (the cached IP is only a routing hint; the
// cert is the identity guarantee). NEVER -k/--insecure: a stale/rotated IP → cert mismatch → the send
// fails CLOSED and falls through, never mis-delivering to a wrong host.
//
// STRUCTURAL ISOLATION (mirrors the keystale test's discipline): CORTEXTOS_BIN=/nonexistent,
// OP_SA_TOKEN_FILE=/nonexistent, and TELEGRAM_API_BASE=http://127.0.0.1:9 (dead). Unlike the keystale
// test we DO supply a (fake) BOT_TOKEN via an agent .env, so tiers 2+3 actually BUILD their curl
// configs — but every send is still structurally impossible: tier 3 DERIVES its URL + --resolve host
// from TELEGRAM_API_BASE (never hardcodes api.telegram.org), so against the dead 127.0.0.1:9 base the
// `--resolve api-host:443:<ip>` directive is a no-op (wrong host+port) and no real send can occur. The
// ISOLATION GUARD test asserts this against the REAL curl: it resolves to ALERT DELIVERY FAILED, never
// an actual send. Mock-curl tests capture the emitted config to assert the TLS integrity (no -k) and
// the derive-from-base invariant structurally.

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');
const ORG = 'testorg';
const AGENT = 'testagent';
const DEAD_BASE = 'http://127.0.0.1:9'; // dead endpoint; api_host derived from this = "127.0.0.1"

let fwRoot: string;        // framework root WITH an agent .env → supplies a FAKE BOT_TOKEN
let mockCurl: string;      // records the resolved --config + exits per-tier configurable code
let mockCortextos: string; // exits 0 → simulates a tier-1 bus-CLI success
let getentFail: string;    // resolver that FAILS (exit 1, empty) → resolve failure
let getentGarbage: string; // resolver that prints a NON-IP → validation failure
let getentSlow: string;    // resolver that HANGS (sleep 10) → exercises the timeout cap

beforeAll(() => {
  fwRoot = mkdtempSync(join(tmpdir(), 'wddb-fw-'));
  const agentDir = join(fwRoot, 'orgs', ORG, 'agents', AGENT);
  mkdirSync(agentDir, { recursive: true });
  // A FAKE token — sends still can't reach a real API (TELEGRAM_API_BASE is a dead/mock endpoint).
  writeFileSync(join(agentDir, '.env'), 'BOT_TOKEN="TESTTOKEN_NOT_REAL"\n');

  const mockDir = mkdtempSync(join(tmpdir(), 'wddb-mock-'));
  // Mock curl: distinguishes tier-3 (a `resolve =` line present) from tier-2, copies the resolved
  // --config to a capture file for assertions, and exits with a per-tier configurable code. It reads
  // only the config file and NEVER performs a network call. (Single-quoted JS lines → no `${}` interp.)
  mockCurl = join(mockDir, 'mock-curl');
  writeFileSync(mockCurl, [
    '#!/usr/bin/env bash',
    'cfg=""; prev=""',
    'for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; prev="$a"; done',
    'if [ -n "$cfg" ] && grep -q "^resolve =" "$cfg" 2>/dev/null; then',
    '  [ -n "${MOCK_T3_CAPTURE:-}" ] && cp "$cfg" "$MOCK_T3_CAPTURE"',
    '  exit "${MOCK_T3_EXIT:-1}"',
    'else',
    '  [ -n "${MOCK_T2_CAPTURE:-}" ] && cp "$cfg" "$MOCK_T2_CAPTURE"',
    '  exit "${MOCK_T2_EXIT:-1}"',
    'fi',
    '',
  ].join('\n'));
  chmodSync(mockCurl, 0o755);

  mockCortextos = join(mockDir, 'mock-cortextos');
  writeFileSync(mockCortextos, ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));
  chmodSync(mockCortextos, 0o755);

  // Mock resolvers (GETENT_BIN) for the cache-warm hardening tests — no real DNS, deterministic.
  getentFail = join(mockDir, 'getent-fail');
  writeFileSync(getentFail, ['#!/usr/bin/env bash', 'exit 1', ''].join('\n'));
  chmodSync(getentFail, 0o755);
  getentGarbage = join(mockDir, 'getent-garbage');
  writeFileSync(getentGarbage, ['#!/usr/bin/env bash', 'echo "garbage not-an-ip token"', ''].join('\n'));
  chmodSync(getentGarbage, 0o755);
  getentSlow = join(mockDir, 'getent-slow');
  writeFileSync(getentSlow, ['#!/usr/bin/env bash', 'sleep 10', 'echo "1.2.3.4 STREAM 1.2.3.4"', ''].join('\n'));
  chmodSync(getentSlow, 0o755);
});

// Sync sleep (no busy subprocess) — used to poll for the BACKGROUNDED tick-warm's write.
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Call cache_telegram_ip(host) directly under the LIB_ONLY seam (source, no monitor run) with a
// controllable resolver, and return { elapsedMs, cache, cacheMode }. Used to prove the resolve
// hardening: timeout-bound + only-write-on-success (a failed/garbage/timed-out resolve preserves
// the pre-existing last-good cache, never clobbering or emptying it).
function runCacheFn(opts: {
  host?: string;
  seedCache?: string;
  getentBin?: string;
  resolveTimeout?: string;
  extra?: Record<string, string>;
} = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wddb-fn-'));
  const wdDir = join(state, 'state/trigger-watchdog');
  mkdirSync(wdDir, { recursive: true });
  const cacheFile = join(wdDir, 'telegram-api-ip.cache');
  if (opts.seedCache !== undefined) writeFileSync(cacheFile, opts.seedCache);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WATCHDOG_LIB_ONLY: '1',
    CTX_ROOT: state,
    CTX_FRAMEWORK_ROOT: fwRoot,
    OP_SA_TOKEN_FILE: '/nonexistent',
    TELEGRAM_API_BASE: DEAD_BASE,
    ...(opts.getentBin ? { GETENT_BIN: opts.getentBin } : {}),
    ...(opts.resolveTimeout ? { WATCHDOG_RESOLVE_TIMEOUT: opts.resolveTimeout } : {}),
    ...(opts.extra ?? {}),
  };
  const host = opts.host ?? '127.0.0.1';
  const start = Date.now();
  execFileSync('bash', ['-c', `source "${SCRIPT}"; cache_telegram_ip "${host}"`], { env, encoding: 'utf-8' });
  const elapsedMs = Date.now() - start;
  const cache = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf-8') : null;
  const cacheMode = existsSync(cacheFile) ? (statSync(cacheFile).mode & 0o777) : -1;
  return { elapsedMs, cache, cacheMode };
}

// Execute the FULL monitor tick (NOT LIB_ONLY) on the real-run path, fully isolated (dead base, no
// keys, status fixture → no network, no alert), and poll for the BACKGROUNDED tick-warm's write.
// The dead base makes the warm resolve the harmless test host (127.0.0.1) into the temp state dir.
function runFullTick(opts: { seedCache?: string; extra?: Record<string, string> } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wddb-tick-'));
  const wdDir = join(state, 'state/trigger-watchdog');
  mkdirSync(wdDir, { recursive: true });
  const cacheFile = join(wdDir, 'telegram-api-ip.cache');
  if (opts.seedCache !== undefined) writeFileSync(cacheFile, opts.seedCache);
  const statusFix = join(state, 'status.json');
  writeFileSync(statusFix, '{"data":{"attributes":{"aggregate_state":"operational"}}}');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // NOT WATCHDOG_LIB_ONLY — run the full monitor tick so the real-run tick-warm fires.
    CTX_ROOT: state,
    WATCHDOG_DRY_RUN: '0',
    CTX_FRAMEWORK_ROOT: fwRoot,
    CTX_ORG: ORG,
    WATCHDOG_BUS_AGENT: AGENT,
    CORTEXTOS_BIN: '/nonexistent',
    OP_SA_TOKEN_FILE: '/nonexistent',
    TELEGRAM_API_BASE: DEAD_BASE,          // dead base → warm resolves the harmless test host, never the real API
    WATCHDOG_CHAT_ID: '000',
    WATCHDOG_STATUS_FIXTURE: statusFix,     // no status network call
    ...(opts.extra ?? {}),
  };
  execFileSync('bash', [SCRIPT], { env, encoding: 'utf-8' });
  // The warm is BACKGROUNDED — poll until it resolves the test host into the cache (offline, instant).
  const deadline = Date.now() + 2000;
  let cache = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf-8') : null;
  while (cache !== '127.0.0.1' && Date.now() < deadline) {
    sleepSync(30);
    cache = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf-8') : null;
  }
  const logPath = join(wdDir, 'watchdog.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const cacheMode = existsSync(cacheFile) ? (statSync(cacheFile).mode & 0o777) : -1;
  return { log, cache, cacheMode };
}

// Seed a fresh state dir (optionally with a cache file), run `send_alert` under the WATCHDOG_LIB_ONLY
// seam with full structural isolation, and return { out, log, exit, cache, t3cfg }.
function runSend(opts: {
  seedCache?: string;      // contents of telegram-api-ip.cache (undefined = cold / no file)
  useRealCurl?: boolean;   // guard test: exercise the REAL curl against the dead base
  tier1Success?: boolean;  // point CORTEXTOS_BIN at the exit-0 mock → tier 1 "delivers"
  t2Exit?: string;         // mock tier-2 exit (default '1' = fail)
  t3Exit?: string;         // mock tier-3 exit (default '1' = fail)
  captureT3?: boolean;     // capture the emitted tier-3 curl config for assertions
  extra?: Record<string, string>;
} = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wddb-st-'));
  const wdDir = join(state, 'state/trigger-watchdog');
  mkdirSync(wdDir, { recursive: true });
  const cacheFile = join(wdDir, 'telegram-api-ip.cache');
  if (opts.seedCache !== undefined) writeFileSync(cacheFile, opts.seedCache);
  const t3capture = join(wdDir, 't3-config.captured');

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WATCHDOG_LIB_ONLY: '1',
    CTX_ROOT: state,
    WATCHDOG_DRY_RUN: '0',                 // NOT dry — exercise the real tier logic
    CTX_FRAMEWORK_ROOT: fwRoot,            // agent .env here supplies the (fake) BOT_TOKEN
    CTX_ORG: ORG,
    WATCHDOG_BUS_AGENT: AGENT,
    CORTEXTOS_BIN: opts.tier1Success ? mockCortextos : '/nonexistent',
    CURL_BIN: opts.useRealCurl ? '/usr/bin/curl' : mockCurl,
    OP_SA_TOKEN_FILE: '/nonexistent',
    TELEGRAM_API_BASE: DEAD_BASE,          // derive-from-base neutralizes tier 3 too
    WATCHDOG_CHAT_ID: '000',
    MOCK_T2_EXIT: opts.t2Exit ?? '1',
    MOCK_T3_EXIT: opts.t3Exit ?? '1',
    ...(opts.captureT3 ? { MOCK_T3_CAPTURE: t3capture } : {}),
    ...(opts.extra ?? {}),
  };
  const out = execFileSync(
    'bash',
    ['-c', `source "${SCRIPT}"; send_alert "unit-test alert"; echo "SEND_EXIT=$?"`],
    { env, encoding: 'utf-8' },
  );
  const logPath = join(wdDir, 'watchdog.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const m = out.match(/SEND_EXIT=(\d+)/);
  const exit = m ? parseInt(m[1], 10) : -1;
  const cache = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf-8') : null;
  const cacheMode = existsSync(cacheFile) ? (statSync(cacheFile).mode & 0o777) : -1;
  const t3cfg = existsSync(t3capture) ? readFileSync(t3capture, 'utf-8') : null;
  return { out: out.trim(), log, exit, cache, cacheMode, t3cfg, cacheFile };
}

describe('trigger-watchdog tier-3 DNS-bypass cached-IP alert fallback', () => {
  // ---- (a) cache-write-on-successful-send ----
  it('cache-write: a SUCCESSFUL tier-1 (bus CLI) send resolves + writes telegram-api-ip.cache (valid IP, 0600)', () => {
    const r = runSend({ tier1Success: true });
    expect(r.log).toContain('alert sent via bus CLI');
    expect(r.exit).toBe(0);
    // api_host derived from TELEGRAM_API_BASE (127.0.0.1), getent-resolved + format-validated:
    expect(r.cache).toBe('127.0.0.1');
    expect(r.cacheMode).toBe(0o600);
  });

  it('cache-write: a SUCCESSFUL tier-2 (raw-curl) send also writes the last-good IP cache', () => {
    const r = runSend({ t2Exit: '0' }); // tier1 fails (/nonexistent), tier2 mock "succeeds"
    expect(r.log).toContain('alert sent via raw-curl fallback');
    expect(r.exit).toBe(0);
    expect(r.cache).toBe('127.0.0.1');
  });

  it('cache-write is best-effort: it never undoes an already-delivered send (send still returns 0)', () => {
    const r = runSend({ tier1Success: true });
    expect(r.exit).toBe(0); // even though the resolve/write is downstream of the delivered alert
  });

  // ---- (b) tier-3 fires on tiers-1+2 failure with a valid cache ----
  it('tier-3 FIRES when tiers 1+2 fail and a valid cache exists — pins the cached IP via --resolve', () => {
    const r = runSend({ seedCache: '149.154.167.220', captureT3: true, t3Exit: '1' });
    expect(r.t3cfg).not.toBeNull();
    // host from the base (127.0.0.1), port 443, cached IP pinned — the exact --resolve directive:
    expect(r.t3cfg).toContain('resolve = "127.0.0.1:443:149.154.167.220"');
    expect(r.log).toContain('tier-3 DNS-bypass send FAILED');
  });

  it('tier-3 DELIVERS when the pinned route works → "alert sent via tier-3", no delivery failure', () => {
    const r = runSend({ seedCache: '149.154.167.220', t3Exit: '0' });
    expect(r.exit).toBe(0);
    expect(r.log).toContain('alert sent via tier-3 DNS-bypass');
    expect(r.log).not.toContain('ALERT DELIVERY FAILED');
  });

  it('tier-3 derives URL + --resolve host from TELEGRAM_API_BASE (NOT hardcoded api.telegram.org) — isolation invariant', () => {
    const r = runSend({ seedCache: '149.154.167.220', captureT3: true });
    expect(r.t3cfg).not.toBeNull();
    expect(r.t3cfg).not.toContain('api.telegram.org'); // a hardcode here would let a test escape isolation
    expect(r.t3cfg).toContain('url = "http://127.0.0.1:9/bot'); // url host = base host → SNI/cert = that host
    expect(r.t3cfg).toContain('127.0.0.1:443:149.154.167.220');
  });

  // ---- (c) stale/wrong cache → cert-validation path → fail closed ----
  it('stale/wrong cached IP → tier-3 keeps cert validation (no -k) → fails CLOSED, falls through loud', () => {
    // 203.0.113.99 (TEST-NET-3) is never Telegram. With cert validation enforced, a real TLS handshake
    // would fail (cert won't match the API host); the mock returns 1 to model that fail-closed outcome.
    const r = runSend({ seedCache: '203.0.113.99', captureT3: true, t3Exit: '1' });
    expect(r.t3cfg).toContain('resolve = "127.0.0.1:443:203.0.113.99"');
    expect(r.t3cfg!.toLowerCase()).not.toContain('insecure');
    expect(r.t3cfg).not.toMatch(/(^|\s)-k(\s|$)/);
    expect(r.exit).toBe(1);                                   // fail closed
    expect(r.log).toContain('tier-3 DNS-bypass send FAILED');
    expect(r.log).toContain('ALERT DELIVERY FAILED');         // fell through, loud
    expect(r.log).not.toContain('alert sent');
  });

  // ---- (d) corrupt cache → tier-3 skipped, logged, no curl-garbage ----
  it('corrupt cache (embedded newline + shell metachars) → tier-3 SKIPPED, logged, NOTHING fed to curl', () => {
    const r = runSend({ seedCache: '1.2.3.4\nrm -rf /', captureT3: true });
    expect(r.t3cfg).toBeNull(); // tier-3 config was NEVER built → the mock never captured a resolve config
    expect(r.log).toContain('cached Telegram IP failed format validation');
    expect(r.log).toContain('tier-3 skipped');
    expect(r.log).not.toContain('alert sent');
    expect(r.exit).toBe(1);
  });

  it.each([
    ['space-separated tokens', '1.2.3.4 5.6.7.8'],
    ['non-IP text', 'not-an-ip'],
    ['out-of-range octet', '999.1.1.1'],
    ['trailing shell metachar', '1.2.3.4;id'],
    ['curl-config injection', 'insecure\nurl = "http://evil"'],
    ['multi-line IP list', '1.2.3.4\n9.9.9.9'],
    ['empty string', ''],
  ])('corrupt cache (%s) → tier-3 skipped, no curl config ever built', (_desc, bad) => {
    const r = runSend({ seedCache: bad, captureT3: true });
    expect(r.t3cfg).toBeNull();
    expect(r.log).toContain('failed format validation');
    expect(r.log).not.toContain('alert sent');
  });

  // ---- (e) cold cache → loud delivery failure, never silent ----
  it('cold cache (no prior successful send) → tier-3 cannot fire → LOUD delivery failure, never silent', () => {
    const r = runSend({}); // no seedCache — first-alert-ever case
    expect(r.log).toContain('ALERT DELIVERY FAILED (both bus CLI and raw curl; no cached IP');
    expect(r.log).toContain('tier-3 DNS-bypass cold');
    expect(r.log).not.toContain('alert sent');
    expect(r.exit).toBe(1);
  });

  // ---- (f) NO -k / --insecure anywhere in the emitted tier-3 curl command ----
  it('TLS integrity: the emitted tier-3 curl config contains NO -k / --insecure (cert validation enforced)', () => {
    const r = runSend({ seedCache: '149.154.167.220', captureT3: true });
    expect(r.t3cfg).not.toBeNull();
    expect(r.t3cfg!.toLowerCase()).not.toContain('insecure');
    expect(r.t3cfg).not.toMatch(/(^|\s)-k(\s|$)/);
    // positively assert the cert-validating structure: pins the route yet keeps the API host in the URL
    expect(r.t3cfg).toContain('resolve = ');
    expect(r.t3cfg).toContain('url = "http://127.0.0.1:9/bot');
  });

  // ---- ISOLATION GUARD — the derive-from-base subtlety, proven against the REAL curl ----
  it('ISOLATION GUARD: valid cache + dead base + REAL curl → resolves to delivery-failed, never a real send', () => {
    // Uses the actual /usr/bin/curl. tier 3 builds `url=http://127.0.0.1:9/...` + `resolve=127.0.0.1:443:...`.
    // curl connects to 127.0.0.1:9 (the base port), so the :443 resolve directive is a no-op and the seeded
    // Telegram IP is NEVER contacted → connection refused → fail closed. This proves the derive-from-base
    // design makes a real Telegram send structurally impossible from a test even WITH a valid cache.
    const r = runSend({ seedCache: '149.154.167.220', useRealCurl: true });
    expect(r.log).toContain('tier-3 DNS-bypass send FAILED'); // attempted, against the dead base
    expect(r.log).toContain('ALERT DELIVERY FAILED');
    expect(r.log).not.toContain('alert sent');                // never an actual send
    expect(r.exit).toBe(1);
  });
});

describe('trigger-watchdog tier-3 cache: healthy-tick warm + resolve hardening', () => {
  // ---- (a) healthy-tick warm: the cache is PREHEATED on a normal tick, sends NOTHING ----
  it('healthy tick (no alert condition) → cache PREHEATED with a valid IP (0600), NO alert sent', () => {
    const r = runFullTick(); // cold cache, no keys, no stall → a clean healthy tick
    expect(r.cache).toBe('127.0.0.1'); // resolved from the TELEGRAM_API_BASE host — the test host
    expect(r.cacheMode).toBe(0o600);
    expect(r.log).not.toContain('alert sent');
    expect(r.log).not.toContain('ALERT DELIVERY FAILED'); // no send of any kind on a healthy tick
  });

  it('healthy tick REFRESHES an existing cache (a pre-seeded stale IP is overwritten to the fresh resolve)', () => {
    const r = runFullTick({ seedCache: '203.0.113.250' });
    expect(r.cache).toBe('127.0.0.1'); // refreshed, not left stale
    expect(r.log).not.toContain('alert sent');
  });

  it('ISOLATION (tick-warm): the dead test base makes the warm resolve the TEST host, never a real Telegram IP', () => {
    const r = runFullTick();
    expect(r.cache).toBe('127.0.0.1');
    expect(r.cache).not.toContain('149.154'); // no real Telegram range ever leaks in
  });

  // ---- (b) ONLY-WRITE-ON-SUCCESS: a failed/garbage resolve PRESERVES the last-good cache ----
  it('cache_telegram_ip: a working resolve writes the cache with a valid IP, 0600', () => {
    const r = runCacheFn({ host: '127.0.0.1' }); // real getent resolves 127.0.0.1 offline
    expect(r.cache).toBe('127.0.0.1');
    expect(r.cacheMode).toBe(0o600);
  });

  it('resolve FAILURE (getent exits non-zero, empty) → last-good cache PRESERVED, never clobbered/emptied', () => {
    const r = runCacheFn({ seedCache: '203.0.113.7', getentBin: getentFail });
    expect(r.cache).toBe('203.0.113.7'); // untouched — the whole value of last-good during a flap
  });

  it('resolve GARBAGE (getent prints a non-IP) → last-good cache PRESERVED (validate-then-write)', () => {
    const r = runCacheFn({ seedCache: '203.0.113.7', getentBin: getentGarbage });
    expect(r.cache).toBe('203.0.113.7');
  });

  it('resolve failure with NO prior cache → nothing written (never creates an empty/garbage cache)', () => {
    const r = runCacheFn({ getentBin: getentFail }); // no seed
    expect(r.cache).toBeNull();
  });

  // ---- (c) TIMEOUT-BOUND: a hanging resolve returns fast + preserves last-good ----
  it('HANGING resolve is TIMEOUT-BOUNDED → returns well under the hang, last-good PRESERVED', () => {
    // getent-slow sleeps 10s; with a 1s cap the call must return in ~1s, not ~10s (never blocks a tick).
    const r = runCacheFn({ seedCache: '203.0.113.7', getentBin: getentSlow, resolveTimeout: '1' });
    expect(r.elapsedMs).toBeLessThan(5000);
    expect(r.cache).toBe('203.0.113.7'); // the timed-out resolve wrote nothing
  });

  // ---- structural: the timeout wrapper + backgrounded tick-warm are actually present ----
  it('the resolve is timeout-wrapped AND the tick-warm is backgrounded in the script (never blocks a tick)', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/"\$TIMEOUT"\s+"\$RESOLVE_TIMEOUT"\s+"\$GETENT"\s+ahostsv4/); // timeout-bounded resolve
    expect(src).toMatch(/cache_telegram_ip\s+"\$\(telegram_api_host\)"[^\n]*&/);       // backgrounded on the tick
  });
});
