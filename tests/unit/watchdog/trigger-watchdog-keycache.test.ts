import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// get_key caching for bin/trigger-watchdog.sh. Root cause it fixes: `op item get` ran every
// 3-min tick (~40 calls/hr) and tripped the 1Password SA rate limit, blinding the watchdog.
// The cache must: serve a fresh key with NO op call; refresh past TTL; and on ANY op failure
// fall back to the last-good cached key instead of going blind.

const SCRIPT = join(__dirname, '../../../bin/trigger-watchdog.sh');
const FIELD = 'hubapp_prod_read_key';
let opStub: string, tokenFile: string, curlStub: string, isoFwRoot: string;

beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'wdkc-fix-'));
  tokenFile = join(d, 'sa-token');
  writeFileSync(tokenFile, 'dummy-sa-token');
  isoFwRoot = mkdtempSync(join(tmpdir(), 'wdkc-fwroot-')); // no agent .env => no token => no real send
  // op stub: appends a line to $STUB_CALLS per invocation; echoes $STUB_KEY unless $STUB_FAIL=1.
  // STUB_FAIL_PRINT=1 => exit nonzero BUT still print (to prove a failed-but-printing op can't poison the cache).
  opStub = join(d, 'op');
  writeFileSync(opStub,
    '#!/bin/bash\n' +
    'echo call >> "$STUB_CALLS"\n' +
    'if [ "${STUB_FAIL:-0}" = "1" ]; then [ "${STUB_FAIL_PRINT:-0}" = "1" ] && printf "%s" "${STUB_KEY:-poison}"; exit 1; fi\n' +
    'printf "%s" "${STUB_KEY:-tr_prod_STUBKEY}"\n');
  chmodSync(opStub, 0o755);
  // curl stub: for a runs fetch (--config <cfg>) it writes a body to the cfg's `output` path and
  // prints $STUB_HTTP (the write-out code); for the status GET (no --config) it prints nothing.
  curlStub = join(d, 'curl');
  writeFileSync(curlStub,
    '#!/bin/bash\n' +
    'cfg=""; for ((i=1;i<=$#;i++)); do [ "${!i}" = "--config" ] && { j=$((i+1)); cfg="${!j}"; }; done\n' +
    'if [ -n "$cfg" ]; then\n' +
    '  body="$(sed -n \'s/.*output = "\\([^"]*\\)".*/\\1/p\' "$cfg")"\n' +
    '  [ -n "$body" ] && echo \'{"error":"unauthorized"}\' > "$body"\n' +
    '  printf "%s" "${STUB_HTTP:-200}"\n' +
    'fi\n');
  chmodSync(curlStub, 0o755);
});
afterAll(() => { /* tmp auto-cleaned by OS */ });

// Run get_key in lib-only mode against a fresh state root; returns {key, opCalls, cachePath}.
function getKey(opts: { fail?: boolean; failPrint?: boolean; ttl?: number; key?: string } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wdkc-st-'));
  const calls = join(state, 'calls');
  const out = execFileSync('bash', ['-c', `source "${SCRIPT}"; get_key "${FIELD}"`], {
    env: {
      ...process.env, WATCHDOG_LIB_ONLY: '1', CTX_ROOT: state, OP_BIN: opStub,
      OP_SA_TOKEN_FILE: tokenFile, STUB_CALLS: calls, STUB_FAIL: opts.fail ? '1' : '0',
      STUB_FAIL_PRINT: opts.failPrint ? '1' : '0',
      STUB_KEY: opts.key ?? 'tr_prod_STUBKEY', WATCHDOG_KEY_TTL: String(opts.ttl ?? 3600),
    },
    encoding: 'utf-8',
  });
  const cachePath = join(state, 'state/trigger-watchdog/keycache', `${FIELD}.key`);
  const opCalls = existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  return { key: out.trim(), opCalls, cachePath, state };
}

// Run get_key twice in the SAME state dir (cache persists between calls).
function getKeyTwice(second: { fail?: boolean; ttl?: number } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'wdkc-st2-'));
  const calls = join(state, 'calls');
  const run = (env: Record<string, string>) => execFileSync('bash', ['-c', `source "${SCRIPT}"; get_key "${FIELD}"`], {
    env: { ...process.env, WATCHDOG_LIB_ONLY: '1', CTX_ROOT: state, OP_BIN: opStub, OP_SA_TOKEN_FILE: tokenFile, STUB_CALLS: calls, STUB_KEY: 'tr_prod_STUBKEY', ...env }, encoding: 'utf-8',
  }).trim();
  const first = run({ STUB_FAIL: '0', WATCHDOG_KEY_TTL: '3600' });            // populate cache
  const second2 = run({ STUB_FAIL: second.fail ? '1' : '0', WATCHDOG_KEY_TTL: String(second.ttl ?? 3600) });
  const opCalls = existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  const cachePath = join(state, 'state/trigger-watchdog/keycache', `${FIELD}.key`);
  return { first, second: second2, opCalls, cachePath, state };
}

describe('trigger-watchdog get_key cache', () => {
  it('cache miss → fetches from op once, returns the key, writes a 0600 cache file', () => {
    const r = getKey();
    expect(r.key).toBe('tr_prod_STUBKEY');
    expect(r.opCalls).toBe(1);
    expect(existsSync(r.cachePath)).toBe(true);
    expect((statSync(r.cachePath).mode & 0o777)).toBe(0o600);
  });

  it('fresh cache hit → returns cached key WITHOUT calling op (the rate-limit fix)', () => {
    const r = getKeyTwice({ ttl: 3600 });
    expect(r.first).toBe('tr_prod_STUBKEY');
    expect(r.second).toBe('tr_prod_STUBKEY');
    expect(r.opCalls).toBe(1); // only the first populated the cache; the second was a cache hit
  });

  it('stale cache (TTL=0) → re-fetches from op', () => {
    const r = getKeyTwice({ ttl: 0 });
    expect(r.second).toBe('tr_prod_STUBKEY');
    expect(r.opCalls).toBe(2); // first populate + second re-fetch (cache stale)
  });

  it('op fails WITH a cached key → last-good fallback (never blind), and it DID retry op', () => {
    const r = getKeyTwice({ fail: true, ttl: 0 });
    expect(r.second).toBe('tr_prod_STUBKEY'); // served from cache despite op failure
    expect(r.opCalls).toBe(2);               // first populated; second hit op (stale TTL) and failed
  });

  it('op fails with NO cache → returns empty (only-then blind)', () => {
    const r = getKey({ fail: true });
    expect(r.key).toBe('');
    expect(r.opCalls).toBe(1);
  });

  it('op exits nonzero but prints to stdout → NOT cached (no poison)', () => {
    const r = getKey({ fail: true, failPrint: true });
    expect(r.key).toBe('');                   // exit-status check rejects the printed output
    expect(existsSync(r.cachePath)).toBe(false);
  });

  it('bust_key_cache removes the cache file', () => {
    const r = getKey(); // creates the cache
    expect(existsSync(r.cachePath)).toBe(true);
    execFileSync('bash', ['-c', `source "${SCRIPT}"; bust_key_cache "${FIELD}"`], {
      env: { ...process.env, WATCHDOG_LIB_ONLY: '1', CTX_ROOT: r.state, OP_BIN: opStub, OP_SA_TOKEN_FILE: tokenFile }, encoding: 'utf-8',
    });
    expect(existsSync(r.cachePath)).toBe(false);
  });

  it('fetch_runs persists the HTTP status to HTTP_CODE_FILE (survives the subshell)', () => {
    const state = mkdtempSync(join(tmpdir(), 'wdkc-fr-'));
    execFileSync('bash', ['-c', `source "${SCRIPT}"; fetch_runs hubapp KEY EXECUTING >/dev/null`], {
      env: { ...process.env, WATCHDOG_LIB_ONLY: '1', CTX_ROOT: state, CURL_BIN: curlStub, STUB_HTTP: '401' }, encoding: 'utf-8',
    });
    expect(readFileSync(join(state, 'state/trigger-watchdog/.lasthttp'), 'utf-8').trim()).toBe('401');
  });

  it('full run: a 401 on the runs API BUSTS the cached key (so next tick re-fetches)', () => {
    // seed a fresh cache for both projects so get_key serves them with NO op (op token absent)
    const state = mkdtempSync(join(tmpdir(), 'wdkc-401-'));
    const kc = join(state, 'state/trigger-watchdog/keycache');
    execFileSync('mkdir', ['-p', kc]);
    for (const f of ['hubapp_prod_read_key', 'helpdesk_prod_read_key']) writeFileSync(join(kc, `${f}.key`), 'tr_prod_SEEDED');
    execFileSync('bash', [SCRIPT], {
      env: {
        ...process.env, CTX_ROOT: state, WATCHDOG_STATUS_FIXTURE: '/dev/null', CURL_BIN: curlStub, STUB_HTTP: '401',
        // never reach op or a real send
        OP_SA_TOKEN_FILE: '/nonexistent', CTX_FRAMEWORK_ROOT: isoFwRoot, CORTEXTOS_BIN: '/nonexistent',
        WATCHDOG_CHAT_ID: '000', TELEGRAM_API_BASE: 'http://127.0.0.1:9', WATCHDOG_KEY_TTL: '3600',
      },
      encoding: 'utf-8',
    });
    // both cache files busted by the 401
    expect(existsSync(join(kc, 'hubapp_prod_read_key.key'))).toBe(false);
    expect(existsSync(join(kc, 'helpdesk_prod_read_key.key'))).toBe(false);
  });
});
