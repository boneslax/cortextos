import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Unit tests for bin/ops-triage-drain.sh — the Solo-side bridge that turns a committed,
// already-redacted ops-triage outbox item into a dev-delegate bus task.
//
// ISOLATION CONTRACT (mirrors tests/unit/watchdog/*, and is the reason this suite is safe
// to run anywhere). A real external write is made STRUCTURALLY IMPOSSIBLE, not merely
// unlikely:
//   * CORTEXTOS_BIN points at a FAKE stub script in a temp dir. The real CLI is never on
//     the path the script uses, so no bus task can ever be created for real.
//   * The stub's `send-telegram` branch always exits 1, forcing the raw-curl fallback,
//     which is pointed at TELEGRAM_API_BASE=http://127.0.0.1:9 (discard port, dead).
//   * CTX_FRAMEWORK_ROOT is an EMPTY temp dir => no agent .env => no BOT_TOKEN is ever
//     resolved, so the curl fallback has no token to send with either.
//   * OP_SA_TOKEN_FILE=/nonexistent => no 1Password secret is ever fetched.
//   * OPS_DRAIN_STATE_DIR / CTX_ROOT / OPS_DRAIN_OUTBOX_DIR are all per-test temp dirs, so
//     nothing touches ~/.cortextos or the real /home/bones/vault checkout.
//   * OPS_DRAIN_NO_SYNC=1 by default => no git clone/fetch/network.

const SCRIPT = join(__dirname, '../../../bin/ops-triage-drain.sh');

const HASH = 'k3zq'; // base36, length 4, contains g-z — the v2 hex-regex regression fixture
const TITLE = `Ops-triage evidence: sig ${HASH}`;
const VALID_ID = 'task_1784413707062_31877972';

let stubBin: string;      // fake cortextos CLI
let failGit: string;      // git stub that always fails
let recGit: string;       // git stub that records argv (proves a verb was never reached)
let recCurl: string;      // curl stub that records the --config file it was handed
let okCurl: string;       // ditto, but reports SUCCESS so the re-alert cadence engages
let isoFwRoot: string;    // empty framework root => no agent .env => no BOT_TOKEN
let tokenFwRoot: string;  // framework root WITH a fake BOT_TOKEN (curl-fallback tests only)

beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), 'opsdrain-bin-'));
  isoFwRoot = mkdtempSync(join(tmpdir(), 'opsdrain-fwroot-'));

  // Fake cortextos CLI. Records every invocation's argv (NUL-separated, so a multi-line
  // --desc survives intact) plus the CTX_* env it was called with, then fakes a response.
  //   STUB_CREATE_FAIL=1  -> create-task prints nothing and exits 1 (poison-pill path)
  //   STUB_ID             -> the id create-task prints (default a valid one)
  //   STUB_TASKS          -> file whose contents list-tasks returns (default [])
  //   STUB_TASKS_POST     -> if set, list-tasks returns THIS once a create has happened in
  //                          the same state dir (lets one tick have an empty dedup scan and
  //                          a populated read-back).
  stubBin = join(d, 'cortextos-stub');
  writeFileSync(stubBin,
    '#!/bin/bash\n' +
    'sd="$STUB_DIR"; mkdir -p "$sd/calls"\n' +
    'n=$(( $(cat "$sd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$sd/n"\n' +
    'printf "%s\\0" "$@" > "$sd/calls/call-$n.argv"\n' +
    '{ printf "CTX_ORG=%s\\n" "${CTX_ORG:-}"; printf "CTX_INSTANCE_ID=%s\\n" "${CTX_INSTANCE_ID:-}";\n' +
    '  printf "CTX_AGENT_NAME=%s\\n" "${CTX_AGENT_NAME:-}";\n' +
    '  printf "CTX_AGENT_DIR=%s\\n" "${CTX_AGENT_DIR:-}";\n' +
    '  printf "CTX_PROJECT_ROOT=%s\\n" "${CTX_PROJECT_ROOT:-}";\n' +
    '  printf "CTX_TIMEZONE=%s\\n" "${CTX_TIMEZONE:-}";\n' +
    '  printf "CTX_ORCHESTRATOR=%s\\n" "${CTX_ORCHESTRATOR:-}"; } > "$sd/calls/call-$n.env"\n' +
    'case "$2" in\n' +
    '  create-task)\n' +
    '    if [ "${STUB_CREATE_FAIL:-0}" = "1" ]; then exit 1; fi\n' +
    '    touch "$sd/created"\n' +
    '    printf "%s\\n" "${STUB_ID:-' + VALID_ID + '}" ;;\n' +
    '  list-tasks)\n' +
    '    if [ -f "$sd/created" ] && [ -n "${STUB_TASKS_POST:-}" ]; then cat "$STUB_TASKS_POST"; \n' +
    '    elif [ -n "${STUB_TASKS:-}" ]; then cat "$STUB_TASKS"; else echo "[]"; fi ;;\n' +
    '  send-telegram) exit 1 ;;\n' +   // never sends; forces the dead-endpoint curl fallback
    '  *) exit 0 ;;\n' +
    'esac\n');
  chmodSync(stubBin, 0o755);

  failGit = join(d, 'git-fail');
  writeFileSync(failGit, '#!/bin/bash\nexit 1\n');
  chmodSync(failGit, 0o755);

  // A git stub that RECORDS its argv instead of running git. Used to prove that the
  // symlink/origin ownership guard refuses BEFORE any destructive verb is reached.
  recGit = join(d, 'git-record');
  writeFileSync(recGit,
    '#!/bin/bash\n' +
    'rd="$GIT_RECORD_DIR"; mkdir -p "$rd"\n' +
    'n=$(( $(cat "$rd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$rd/n"\n' +
    'printf "%s\\0" "$@" > "$rd/argv-$n"\n' +
    'exit 1\n');
  chmodSync(recGit, 0o755);

  // A curl stub that COPIES the --config file it was handed and exits non-zero. It never
  // opens a socket, so the alert path can be inspected byte-for-byte with zero network
  // reachability (belt and braces on top of TELEGRAM_API_BASE pointing at a dead port).
  recCurl = join(d, 'curl-record');
  writeFileSync(recCurl,
    '#!/bin/bash\n' +
    'rd="$CURL_RECORD_DIR"; mkdir -p "$rd"\n' +
    'n=$(( $(cat "$rd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$rd/n"\n' +
    'printf "%s\\0" "$@" > "$rd/argv-$n"\n' +
    'prev=""\n' +
    'for a in "$@"; do if [ "$prev" = "--config" ]; then cp "$a" "$rd/cfg-$n"; fi; prev="$a"; done\n' +
    'exit 1\n');
  chmodSync(recCurl, 0o755);

  // Same recorder, but exits 0. STILL SOCKET-LESS — it never runs curl, it only copies the
  // config file. Needed because a FAILED delivery persists last=0, which disables the
  // re-alert cadence entirely; the alert-key cross-talk bug is only observable when
  // deliveries succeed and the cadence can suppress a second signature's alert.
  okCurl = join(d, 'curl-ok');
  writeFileSync(okCurl,
    '#!/bin/bash\n' +
    'rd="$CURL_RECORD_DIR"; mkdir -p "$rd"\n' +
    'n=$(( $(cat "$rd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$rd/n"\n' +
    'prev=""\n' +
    'for a in "$@"; do if [ "$prev" = "--config" ]; then cp "$a" "$rd/cfg-$n"; fi; prev="$a"; done\n' +
    'exit 0\n');
  chmodSync(okCurl, 0o755);

  // A framework root that DOES resolve a BOT_TOKEN, so the raw-curl fallback branch is
  // actually entered. Paired with the recording curl stub above, never with a real curl.
  tokenFwRoot = mkdtempSync(join(tmpdir(), 'opsdrain-fwtok-'));
  mkdirSync(join(tokenFwRoot, 'orgs', 'vault', 'agents', 'solo'), { recursive: true });
  writeFileSync(join(tokenFwRoot, 'orgs', 'vault', 'agents', 'solo', '.env'),
    'BOT_TOKEN="fake-token-not-a-real-bot"\nCHAT_ID="000"\n');
});

// ---------------------------------------------------------------- fixtures

function outboxItem(over: Record<string, unknown> = {}) {
  return {
    marker: 'NOT_A_SPEC',
    assignee: 'dev-delegate',
    bucket: 'real-bug',
    task: 'hub-sync-contacts',
    moduleOther: '',
    project: 'hub',
    count: 4,
    newestFailureAt: '2026-07-18T10:00:56.789Z',
    runLink: 'https://cloud.trigger.dev/runs/run_abc',
    evidence: 'TypeError: cannot read property id of undefined',
    ...over,
  };
}

function carrier(over: Record<string, unknown> = {}) {
  return {
    id: 'task_1700000000000_00000001',
    title: TITLE,
    assigned_to: 'dev-delegate',
    status: 'pending',
    archived: false,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    completed_at: null,
    ...over,
  };
}

/**
 * A gate dir whose IDENTITY.md carries all four preflight invariants — deliberately ONE
 * INVARIANT PER LINE, so `drop` can remove exactly one and the per-invariant tests are
 * genuinely independent (the old fixture put graphify and approval on the same line, so
 * dropping one silently dropped two).
 *
 * The wording tracks the REAL dev-delegate IDENTITY.md, because the invariant phrases are
 * now specific gate prose rather than bare tokens ("graphify" alone was satisfied by any
 * passing mention; "approval" by the machine key `"approval_rules":`).
 *
 * `reword` is the tolerance fixture: same wording, different CASE and WHITESPACE only
 * (including a line wrap mid-phrase). That is the exact and only drift the tripwire is
 * meant to forgive.
 *
 * config.json is deliberately a STUB here. The live one paraphrases every hard line in its
 * heartbeat prompt, and the round-2 finding was that concatenating it with IDENTITY.md made
 * the tripwire inert — see the `config.json cannot satisfy an IDENTITY invariant` tests.
 */
const GATE_LINES: Record<string, string> = {
  graphify: 'Heartbeat gate: I graphify the target repo first (map-before-plan).',
  approval: 'Bones reviews the hardened plan and approves. NO build before approval.',
  merge:    'I never merge to main. I hand Bones the PR.',
  external: 'I never fire external writes (Hudu pushes, sends, deploys).',
};

function gateDir(opts: { drop?: keyof typeof GATE_LINES; reword?: boolean; config?: unknown } = {}) {
  const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-'));
  mkdirSync(g, { recursive: true });
  const lines = opts.reword
    ? {
        // every phrase preserved verbatim — only CASE and WHITESPACE differ, including
        // wraps placed mid-phrase, which is the whole tolerance contract
        graphify: 'Heartbeat gate: I   GRAPHIFY\n   THE TARGET\tREPO first (map-before-plan).',
        approval: 'Bones reviews the hardened plan and approves.\n   No   BUILD\n\tBEFORE\n APPROVAL.',
        merge:    'You must never\n\tmerge   to\n  main under any circumstances.',
        external: 'You must never fire any External\n   Writes without a human go.',
      }
    : { ...GATE_LINES };
  if (opts.drop) delete (lines as Record<string, string>)[opts.drop];
  writeFileSync(join(g, 'IDENTITY.md'), Object.values(lines).join('\n') + '\n');
  writeFileSync(join(g, 'config.json'), JSON.stringify(opts.config ?? { name: 'dev-delegate' }));
  return g;
}

/**
 * A config.json shaped like the LIVE one: its heartbeat prompt paraphrases every hard line
 * and it carries the `approval_rules` key. Under the old union-of-both-files matching this
 * single file satisfied all four invariants on its own.
 */
const LIVE_SHAPED_CONFIG = {
  name: 'dev-delegate',
  approval_rules: { require: ['external-comms'] },
  heartbeat: {
    prompt:
      'Read HEARTBEAT.md + IDENTITY.md. Work the gated flow (graphify the target repo -> ' +
      'plan -> dual-adversarial plan gate -> Bones approval -> build). NO build before ' +
      'approval. Never merge to main, never fire external writes.',
  },
};

// ---------------------------------------------------------------- harness

interface Ctx {
  state: string;
  outbox: string;
  stubDir: string;
  gate: string;
  cwd: string;
}

function ctx(opts: { gate?: string } = {}): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'opsdrain-ctx-'));
  const state = join(root, 'state');
  const outbox = join(root, 'outbox');
  const stubDir = join(root, 'stub');
  const cwd = join(root, 'cwd');
  for (const p of [state, outbox, stubDir, cwd]) mkdirSync(p, { recursive: true });
  return { state, outbox, stubDir, gate: opts.gate ?? gateDir(), cwd };
}

function writeItem(c: Ctx, hash: string, item: unknown) {
  writeFileSync(join(c.outbox, `${hash}.json`), JSON.stringify(item, null, 2));
}

function tick(c: Ctx, env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    cwd: c.cwd,
    env: {
      ...process.env,
      OPS_DRAIN_STATE_DIR: c.state,
      OPS_DRAIN_OUTBOX_DIR: c.outbox,
      OPS_DRAIN_GATE_DIR: c.gate,
      OPS_DRAIN_NO_SYNC: '1',
      CORTEXTOS_BIN: stubBin,
      STUB_DIR: c.stubDir,
      // --- isolation (see header) ---
      CTX_ROOT: join(c.state, 'ctxroot'),
      CTX_FRAMEWORK_ROOT: isoFwRoot,
      OP_SA_TOKEN_FILE: '/nonexistent',
      TELEGRAM_API_BASE: 'http://127.0.0.1:9',
      OPS_DRAIN_CHAT_ID: '000',
      ...env,
    },
    encoding: 'utf-8',
  });
}

interface Call { argv: string[]; env: Record<string, string>; }

function calls(c: Ctx): Call[] {
  const dir = join(c.stubDir, 'calls');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.argv'))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map(f => {
      const argv = readFileSync(join(dir, f), 'utf-8').split('\0').slice(0, -1);
      const envTxt = readFileSync(join(dir, f.replace('.argv', '.env')), 'utf-8');
      const env: Record<string, string> = {};
      for (const line of envTxt.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
      }
      return { argv, env };
    });
}

const creates = (c: Ctx) => calls(c).filter(x => x.argv[1] === 'create-task');
const scans = (c: Ctx) => calls(c).filter(x => x.argv[1] === 'list-tasks');
const log = (c: Ctx) => (existsSync(join(c.state, 'drain.log')) ? readFileSync(join(c.state, 'drain.log'), 'utf-8') : '');

/**
 * Every alert body actually handed to the transport, in order. This is the "was it
 * DELIVERED" oracle: an alert suppressed by the re-alert cadence never reaches here, which
 * is exactly how a shared alert key silently swallows a second signature's alert.
 */
function alertTexts(recDir: string): string[] {
  if (!existsSync(recDir)) return [];
  return readdirSync(recDir)
    .filter(f => f.startsWith('cfg-'))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map(f => readFileSync(join(recDir, f), 'utf-8'))
    .map(t => (t.match(/^data-urlencode = "text=(.*)"$/m) ?? ['', ''])[1]);
}

/** Env that routes alerts through the socket-less RECORDING curl stub that reports success. */
function alertEnv(rec: string): Record<string, string> {
  return { CTX_FRAMEWORK_ROOT: tokenFwRoot, CURL_BIN: okCurl, CURL_RECORD_DIR: rec };
}

const qcount = (c: Ctx, h: string) =>
  (existsSync(join(c.state, 'quarantine', h)) ? readFileSync(join(c.state, 'quarantine', h), 'utf-8') : '0');

/**
 * Clear the stub's "a create already happened" flag so the NEXT tick starts with an empty
 * dedup scan again (STUB_TASKS) and only flips to STUB_TASKS_POST for its own read-back.
 * Without this, tick 2's scan would still see tick 1's carrier and the test would exercise
 * the carrier branch instead of the ledger branch it means to cover.
 */
function resetPost(c: Ctx) {
  const f = join(c.stubDir, 'created');
  if (existsSync(f)) rmSync(f);
}

/** Write a list-tasks fixture file and return its path. */
function tasksFixture(c: Ctx, name: string, tasks: unknown[]) {
  const p = join(c.state, `${name}.json`);
  writeFileSync(p, JSON.stringify(tasks));
  return p;
}

/** Recursively collect every file path under a dir (for the "no pwned" assertion). */
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

// ================================================================ tests

describe('ops-triage-drain: hash contract', () => {
  it('accepts a base36 hash (g-z letters, length 4) and drains it — the v2 hex-regex regression', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
    expect(creates(c)[0].argv).toContain(TITLE);
  });

  it('rejects a hash outside ^[0-9a-z]{1,16}$ → quarantined, alerted, zero creates', () => {
    const c = ctx();
    writeItem(c, 'BAD-Hash', outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/invalid hash/i);
    expect(existsSync(join(c.state, 'alert.badhash.BAD-Hash.json'))).toBe(true); // per-signature key
  });
});

describe('ops-triage-drain: argv safety', () => {
  it('builds exactly the glued-option + end-of-options argv with an INTERNAL title', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    const argv = creates(c)[0].argv;
    expect(argv[0]).toBe('bus');
    expect(argv[1]).toBe('create-task');
    expect(argv[2].startsWith('--desc=')).toBe(true);   // glued, single argv element
    expect(argv[3]).toBe('--assignee=dev-delegate');    // glued
    expect(argv[4]).toBe('--needs-approval');
    expect(argv[5]).toBe('--');                          // end-of-options guard
    expect(argv[6]).toBe(TITLE);                         // internally constructed
    expect(argv).toHaveLength(7);                        // nothing else, no free text
  });

  it('the outbox title/task text NEVER reaches the title argv (flag-injection neutralized)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ moduleOther: '--needs-approval x', task: '--assignee=attacker' }));
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    const argv = creates(c)[0].argv;
    expect(argv[6]).toBe(TITLE);                         // still the internal title
    expect(argv.filter(a => a === '--assignee=attacker')).toHaveLength(0);
    expect(argv.filter(a => a === '--needs-approval')).toHaveLength(1); // ours only
    // the hostile text is present only INSIDE the single --desc value
    expect(argv[2]).toContain('--needs-approval x');
  });

  it('shell-injection in evidence passes as ONE literal argv value and executes nothing', () => {
    const c = ctx();
    const nasty = '$(touch pwned) `touch pwned2` ; touch pwned3\n--- leading dash line\n${IFS}';
    writeItem(c, HASH, outboxItem({ evidence: nasty, project: '&& touch pwned4' }));
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });

    const argv = creates(c)[0].argv;
    expect(creates(c)).toHaveLength(1);
    expect(argv).toHaveLength(7);                        // no argv splitting occurred
    expect(argv[2]).toContain('$(touch pwned)');         // literal, unexpanded
    expect(argv[2]).toContain('`touch pwned2`');
    expect(argv[2]).toContain('${IFS}');
    expect(argv[2]).toContain('UNTRUSTED EVIDENCE');     // fenced

    // control chars (the embedded newline) stripped by the sanitizer
    expect(argv[2]).not.toContain('\n--- leading dash line');

    // and nothing was ever executed anywhere the script could have written
    for (const root of [c.cwd, c.state, c.outbox, c.stubDir]) {
      expect(walk(root).filter(p => /pwned/.test(p))).toEqual([]);
    }
  });

  it('caps each user-controlled field (no unbounded desc from a huge evidence blob)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ evidence: 'A'.repeat(9000) }));
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)[0].argv[2]).not.toContain('A'.repeat(1801));
    expect(creates(c)[0].argv[2]).toContain('A'.repeat(1800));
  });
});

describe('ops-triage-drain: shape gate', () => {
  it('skips an item missing marker/assignee (not a trust boundary, but a shape check)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ marker: 'SOMETHING_ELSE' }));
    writeItem(c, 'j7p', outboxItem({ assignee: 'someone-else' }));
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/shape/i);
  });
});

describe('ops-triage-drain: dedup matrix (epoch-normalized, closed-at = completed_at // updated_at)', () => {
  it('ACTIVE carrier → skip, no create', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({ status: 'in_progress' })]) });
    expect(creates(c)).toHaveLength(0);
  });

  it('COMPLETED carrier + newestFailureAt <= closed-at → no create (quiet closed bug stays closed)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T12:00:00Z', completed_at: '2026-07-18T12:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
  });

  it('COMPLETED carrier + newestFailureAt > closed-at → re-create (genuine recurrence)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T13:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T12:00:00Z', completed_at: '2026-07-18T12:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
  });

  it('CANCELLED carrier (completed_at:null) + newestFailureAt <= updated_at → no create — respects the human "no"', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'cancelled', updated_at: '2026-07-18T12:00:00Z', completed_at: null,
    })]);
    // Two ticks: a completed_at-only implementation compares against null and re-drains EVERY tick.
    tick(c, { STUB_TASKS: t });
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
  });

  it('CANCELLED carrier + a genuinely newer failure → re-create', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T13:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'cancelled', updated_at: '2026-07-18T12:00:00Z', completed_at: null,
    })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
  });

  it('same-second: closed …56Z vs failure …56.789Z → NOT newer, no create', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:56.789Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T10:00:56Z', completed_at: '2026-07-18T10:00:56Z',
    })]);
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
  });

  it('EPOCH NORMALIZATION: an offset-form closed-at equal to the failure instant → no create (a raw string compare would invert and re-drain)', () => {
    const c = ctx();
    // 2026-07-18T03:00:56-07:00 === 2026-07-18T10:00:56Z. Lexicographically "10:.." > "03:.."
    // so a raw compare says "newer" and re-drains; epoch-normalized they are the same second.
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:56.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T03:00:56-07:00', completed_at: '2026-07-18T03:00:56-07:00',
    })]);
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
  });

  it('matches the hash FIELD-ANCHORED — a task whose title merely contains the hash is not a carrier', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const t = tasksFixture(c, 't', [carrier({ title: `Something about ${HASH} in the middle`, status: 'in_progress' })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1); // not deduped by a substring false-match
  });

  it('a carrier assigned to a DIFFERENT agent is not a carrier', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const t = tasksFixture(c, 't', [carrier({ assigned_to: 'someone-else', status: 'in_progress' })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
  });
});

describe('ops-triage-drain: durable drained-ledger (no carrier)', () => {
  it('hash absent from ledger → create + upsert the ledger with newestFailureAt', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(c.state, 'drained.json'), 'utf-8'));
    expect(ledger[HASH]).toBe('2026-07-18T10:00:56.789Z');
  });

  it('in ledger + newestFailureAt <= ledger → skip (drained-then-archived stays drained)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const post = tasksFixture(c, 'post', [carrier({ id: VALID_ID })]);
    tick(c, { STUB_TASKS_POST: post });          // first drain, ledger upserted
    resetPost(c);                                // carrier archived out of the queue
    tick(c, { STUB_TASKS_POST: post });          // no carrier → the ledger decides
    expect(creates(c)).toHaveLength(1);
  });

  it('in ledger + newestFailureAt > ledger → re-create', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const post = tasksFixture(c, 'post', [carrier({ id: VALID_ID })]);
    tick(c, { STUB_TASKS_POST: post });
    resetPost(c);                                // carrier archived out of the queue
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-19T10:00:00.000Z' })); // genuine re-flare
    tick(c, { STUB_TASKS_POST: post });
    expect(creates(c)).toHaveLength(2);
    const ledger = JSON.parse(readFileSync(join(c.state, 'drained.json'), 'utf-8'));
    expect(ledger[HASH]).toBe('2026-07-19T10:00:00.000Z');
  });

  it('a never-drained item written while the drainer was down is drained on recovery (downtime-independent)', () => {
    const c = ctx();
    // ledger already holds an unrelated hash; ours is absent => must drain regardless of age
    writeFileSync(join(c.state, 'drained.json'), JSON.stringify({ zz9: '2026-01-01T00:00:00.000Z' }));
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2020-01-01T00:00:00.000Z' })); // ancient
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
  });
});

describe('ops-triage-drain: CTX env pinning', () => {
  it('create, the dedup scan, and the read-back all run with identical pinned CTX env', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    const all = calls(c);
    expect(all.length).toBeGreaterThanOrEqual(3); // scan + create + read-back
    for (const call of all) {
      expect(call.env.CTX_ORG).toBe('vault');            // without this the scan reads an empty dir
      expect(call.env.CTX_INSTANCE_ID).toBe('default');
      expect(call.env.CTX_AGENT_NAME).toBeTruthy();
    }
    const pins = new Set(all.map(x => `${x.env.CTX_ORG}|${x.env.CTX_INSTANCE_ID}|${x.env.CTX_AGENT_NAME}`));
    expect(pins.size).toBe(1); // identical across all three
  });

  it('an inherited hostile CTX_ORG from the calling shell is overridden, not honored', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { CTX_ORG: 'someone-elses-org', STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    for (const call of calls(c)) expect(call.env.CTX_ORG).toBe('vault');
  });
});

describe('ops-triage-drain: read-back', () => {
  it('read-back MISS → no ledger upsert, no re-create in the same tick', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c); // list-tasks always [] => scan empty AND read-back misses
    expect(creates(c)).toHaveLength(1);
    expect(log(c)).toMatch(/read-back miss/i);
    const ledger = existsSync(join(c.state, 'drained.json'))
      ? JSON.parse(readFileSync(join(c.state, 'drained.json'), 'utf-8')) : {};
    expect(ledger[HASH]).toBeUndefined();
  });

  it('read-back miss then an ACTIVE carrier next tick → ADOPTED, never re-created', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c);                                                     // creates, read-back misses
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({ id: VALID_ID, status: 'pending' })]) });
    expect(creates(c)).toHaveLength(1);                          // reconciled through the queue
  });

  it('an invalid task id from the CLI is rejected (never read back by title)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_ID: 'Error: something went wrong' });
    expect(log(c)).toMatch(/invalid.*id/i);
    const ledger = existsSync(join(c.state, 'drained.json'))
      ? JSON.parse(readFileSync(join(c.state, 'drained.json'), 'utf-8')) : {};
    expect(ledger[HASH]).toBeUndefined();
  });
});

describe('ops-triage-drain: poison-pill quarantine', () => {
  it('a create that keeps failing quarantines after N attempts — no infinite retry', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    for (let i = 0; i < 6; i++) tick(c, { STUB_CREATE_FAIL: '1', OPS_DRAIN_QUARANTINE_MAX: '3' });
    expect(creates(c)).toHaveLength(3);                      // stopped trying at the cap
    expect(existsSync(join(c.state, `alert.quarantine.${HASH}.json`))).toBe(true);
    expect(log(c)).toMatch(/quarantin/i);
  });
});

describe('ops-triage-drain: quarantine is per-signature, consecutive, and recoverable', () => {
  const A = 'aaa1';
  const B = 'bbb2';
  const futureISO = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

  it('TWO quarantined signatures each produce their OWN delivered alert', () => {
    // Round-2 BLOCKER: the alert key was the fixed string "quarantine", so the first
    // signature's cadence marker suppressed the second one's alert forever. Two bad
    // signatures produced two alerts — BOTH naming the first hash. The second was bricked
    // with zero human-visible signal.
    const c = ctx();
    const rec = join(c.state, 'curlrec');
    writeItem(c, A, outboxItem({ newestFailureAt: 'now' }));   // unparseable => bumps
    writeItem(c, B, outboxItem({ newestFailureAt: 'now' }));
    for (let i = 0; i < 4; i++) tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3', ...alertEnv(rec) });

    const texts = alertTexts(rec);
    expect(texts.filter(t => t.includes(`signature ${A} QUARANTINED`)).length).toBeGreaterThan(0);
    expect(texts.filter(t => t.includes(`signature ${B} QUARANTINED`)).length).toBeGreaterThan(0);
    expect(existsSync(join(c.state, `alert.quarantine.${A}.json`))).toBe(true);
    expect(existsSync(join(c.state, `alert.quarantine.${B}.json`))).toBe(true);
    expect(existsSync(join(c.state, 'alert.quarantine.json'))).toBe(false); // no shared key
  });

  it('the counter tracks CONSECUTIVE failures — one transient miss then a healthy skip clears it', () => {
    // Round-2 BLOCKER: quarantine_clear ran only on the full create+read-back+ledger
    // success path, so a single transient read-back miss stuck at 1 forever and three
    // unrelated blips months apart eventually bricked the signature.
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c);                                   // list-tasks [] => create, read-back MISS
    expect(qcount(c, HASH)).toBe('1');

    // a healthy SKIP (an active carrier is already queued) — not a drain
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({ status: 'in_progress' })]) });
    expect(qcount(c, HASH)).toBe('0');
    expect(existsSync(join(c.state, 'quarantine', HASH))).toBe(false);
    expect(log(c)).toMatch(/healthy outcome — clearing the consecutive-failure counter/);
  });

  it('a healthy skip on the ALREADY-DRAINED path also clears the counter', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const post = tasksFixture(c, 'post', [carrier({ id: VALID_ID })]);
    tick(c, { STUB_TASKS_POST: post });        // real drain => ledger upserted
    resetPost(c);                              // carrier archived out of the queue
    mkdirSync(join(c.state, 'quarantine'), { recursive: true });
    writeFileSync(join(c.state, 'quarantine', HASH), '2');  // a stale streak from earlier
    tick(c, { STUB_TASKS_POST: post });        // ledger says already drained => healthy skip
    expect(log(c)).toMatch(/already drained/);
    expect(qcount(c, HASH)).toBe('0');
  });

  it('a terminal carrier closed at/after the failure clears the counter too', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    mkdirSync(join(c.state, 'quarantine'), { recursive: true });
    writeFileSync(join(c.state, 'quarantine', HASH), '2');
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T12:00:00Z', completed_at: '2026-07-18T12:00:00Z',
    })]) });
    expect(creates(c)).toHaveLength(0);
    expect(qcount(c, HASH)).toBe('0');
  });

  it('HOST CLOCK SKEW: quarantined by a 48h-future timestamp, then RECOVERS once it is valid', () => {
    // The documented failure mode: a host clock running days ahead makes every timestamp
    // look implausibly future-dated, so the item quarantines in QUARANTINE_MAX ticks. The
    // quarantine gate is checked BEFORE the timestamp parse (deliberately — a permanently
    // unparseable item must be bounded), which made that a ONE-WAY DOOR: after the clock
    // was fixed the signature stayed bricked forever.
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: futureISO(48) }));
    for (let i = 0; i < 4; i++) tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    expect(creates(c)).toHaveLength(0);
    expect(qcount(c, HASH)).toBe('3');
    expect(log(c)).toMatch(/QUARANTINED|quarantined \(3/);

    // clock fixed => the cloud task rewrites the item with a sane timestamp
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:56.789Z' }));
    tick(c, {
      OPS_DRAIN_QUARANTINE_MAX: '3',
      STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]),
    });
    expect(log(c)).toMatch(/content changed — resetting the consecutive-failure counter/);
    expect(creates(c)).toHaveLength(1);        // it drains: not bricked forever
    expect(qcount(c, HASH)).toBe('0');
  });

  it('UNCHANGED evidence does NOT reset the streak (the bound still bounds a real poison pill)', () => {
    // The discriminator for the content-fingerprint reset: rewriting the SAME bytes must
    // not hand a genuine poison pill an unlimited retry budget.
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: 'now' }));
    for (let i = 0; i < 8; i++) {
      writeItem(c, HASH, outboxItem({ newestFailureAt: 'now' })); // identical bytes each tick
      tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    }
    expect(creates(c)).toHaveLength(0);
    expect(qcount(c, HASH)).toBe('3');         // capped, never climbing past the max
  });

  it('alert keys do not cross-talk: a healthy tick for one signature leaves the other alerted', () => {
    const c = ctx();
    const rec = join(c.state, 'curlrec');
    writeItem(c, A, outboxItem());
    writeItem(c, B, outboxItem());
    tick(c, alertEnv(rec));                    // both create, both read-back MISS
    expect(existsSync(join(c.state, `alert.readback.${A}.json`))).toBe(true);
    expect(existsSync(join(c.state, `alert.readback.${B}.json`))).toBe(true);
    expect(existsSync(join(c.state, 'alert.readback.json'))).toBe(false);

    // an active carrier appears for A only => A recovers, B is still broken
    tick(c, {
      // a DIFFERENT id from the one create-task hands back, so B's read-back still misses
      STUB_TASKS: tasksFixture(c, 't', [carrier({
        id: 'task_1700000000000_00000042', title: `Ops-triage evidence: sig ${A}`, status: 'pending',
      })]),
      ...alertEnv(rec),
    });
    expect(existsSync(join(c.state, `alert.readback.${A}.json`))).toBe(false); // cleared
    expect(existsSync(join(c.state, `alert.readback.${B}.json`))).toBe(true);  // untouched
  });

  it('two invalid-hash files each get their own badhash alert key', () => {
    const c = ctx();
    writeItem(c, 'BAD-One', outboxItem());
    writeItem(c, 'BAD-Two', outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'alert.badhash.BAD-One.json'))).toBe(true);
    expect(existsSync(join(c.state, 'alert.badhash.BAD-Two.json'))).toBe(true);
  });
});

describe('ops-triage-drain: heartbeat must not lie about a bricked outbox', () => {
  const futureISO = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  /** Drive one signature to the quarantine cap, then remove the heartbeat file. */
  function brick(c: Ctx, hash: string) {
    writeItem(c, hash, outboxItem({ newestFailureAt: futureISO(48) }));
    for (let i = 0; i < 3; i++) tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    rmSync(join(c.state, 'heartbeat'), { force: true });
  }

  it('a tick where EVERY outbox item is quarantined does NOT refresh the heartbeat', () => {
    // Round-2 finding: the heartbeat was touched unconditionally on any completed tick, so
    // the external staleness watcher could not tell a working drainer from a fully bricked
    // one — 100% of the outbox quarantined, zero creates, heartbeat perfectly fresh.
    const c = ctx();
    brick(c, HASH);
    tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(false);
    expect(log(c)).toMatch(/HEARTBEAT SUPPRESSED/);
  });

  it('an EMPTY outbox still refreshes the heartbeat (nothing to drain is not a fault)', () => {
    const c = ctx();
    tick(c);
    rmSync(join(c.state, 'heartbeat'), { force: true });
    tick(c);
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(true);
  });

  it('a tick of legitimate HEALTHY SKIPS still refreshes the heartbeat', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({ status: 'in_progress' })]) });
    rmSync(join(c.state, 'heartbeat'), { force: true });
    tick(c, { STUB_TASKS: tasksFixture(c, 't', [carrier({ status: 'in_progress' })]) });
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(true);
  });

  it('a MIXED tick (one quarantined, one healthy) still refreshes the heartbeat', () => {
    const c = ctx();
    brick(c, 'aaa1');
    writeItem(c, 'bbb2', outboxItem());
    tick(c, {
      OPS_DRAIN_QUARANTINE_MAX: '3',
      STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({
        id: VALID_ID, title: 'Ops-triage evidence: sig bbb2',
      })]),
    });
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(true);
  });
});

describe('ops-triage-drain: outbox source isolation', () => {
  it('nullglob: an absent or empty outbox is a clean no-op (exit 0, zero creates)', () => {
    const c = ctx();
    expect(() => tick(c)).not.toThrow();
    expect(creates(c)).toHaveLength(0);
    const c2 = ctx();
    expect(() => tick(c2, { OPS_DRAIN_OUTBOX_DIR: join(c2.state, 'does-not-exist') })).not.toThrow();
    expect(creates(c2)).toHaveLength(0);
  });

  it('defaults the outbox to the drainer OWN clone under $STATE — never the shared /home/bones/vault checkout', () => {
    const c = ctx();
    const out = tick(c, { OPS_DRAIN_OUTBOX_DIR: '', OPS_DRAIN_DRY_RUN: '1' });
    const m = out.match(/^OUTBOX=(.*)$/m);
    expect(m).toBeTruthy();
    expect(m![1]).toContain(c.state);
    expect(m![1]).not.toBe('/home/bones/vault/knowledge/ops-triage/outbox');
    expect(m![1].startsWith('/home/bones/vault')).toBe(false);
  });

  it('a git fetch failure ALERTS and drains nothing (never silently drains stale)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    mkdirSync(join(c.state, 'vault-clone', '.git'), { recursive: true });
    tick(c, { OPS_DRAIN_NO_SYNC: '0', OPS_DRAIN_GIT_BIN: failGit });
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'alert.sync.json'))).toBe(true);
    expect(log(c)).toMatch(/sync|fetch/i);
  });
});

describe('ops-triage-drain: preflight drift tripwire', () => {
  // ONE TEST PER INVARIANT. Previously only the `external` token had coverage, so deleting
  // "never-merge-main" from the invariant list still passed the whole suite — an untested
  // tripwire is not a tripwire. Each case removes exactly one invariant line.
  for (const inv of ['graphify', 'approval', 'merge', 'external'] as const) {
    it(`a MISSING gate invariant (${inv}) → refuse, alert, zero creates`, () => {
      const c = ctx({ gate: gateDir({ drop: inv }) });
      writeItem(c, HASH, outboxItem());
      tick(c);
      expect(creates(c)).toHaveLength(0);
      expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(true);
      expect(log(c)).toMatch(/preflight/i);
    });
  }

  it('the merge invariant is matched as a PHRASE — "merge" and "main" scattered elsewhere do not satisfy it', () => {
    // The word-splitting implementation checked "merge" and "main" independently, so this
    // gate (invariant deleted, both words present in unrelated prose) passed the tripwire.
    const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-split-'));
    writeFileSync(join(g, 'IDENTITY.md'), [
      'Heartbeat gate: I graphify the target repo first (map-before-plan).',
      'Bones reviews the hardened plan and approves. NO build before approval.',
      'I never fire external writes.',
      // every word of the phrase appears — "merge", "to", "main" — but not the invariant
      'I merge my feature branches often, I push to origin, and main is the trunk.',
    ].join('\n'));
    writeFileSync(join(g, 'config.json'), JSON.stringify({ name: 'dev-delegate' }));
    const c = ctx({ gate: g });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/never-merge-main/);
  });

  // ---- the tripwire must watch IDENTITY.md SPECIFICALLY -------------------------------
  // Round-2 finding: preflight concatenated config.json + IDENTITY.md and matched the
  // phrases across the union. The LIVE config.json's heartbeat prompt already paraphrases
  // every hard line, so against the real gate dir the tripwire was completely inert —
  // emptying IDENTITY.md produced ZERO refusals. The four drop-one tests only passed
  // because the fixture's config.json was a stub.
  it('config.json carries every phrase but IDENTITY.md is EMPTY → REFUSE', () => {
    const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-inert-'));
    writeFileSync(join(g, 'config.json'), JSON.stringify(LIVE_SHAPED_CONFIG));
    writeFileSync(join(g, 'IDENTITY.md'), '');   // the gate prose is gone entirely
    const c = ctx({ gate: g });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(true);
    expect(log(c)).toMatch(/PREFLIGHT REFUSE/);
    expect(log(c)).toMatch(/IDENTITY\.md is empty/);
  });

  it('config.json carries every phrase but IDENTITY.md is INVERTED → REFUSE', () => {
    // A phrase tripwire detects REMOVAL, not negation — but inverting the gate necessarily
    // rewrites the surrounding prose away, and that is what trips it here.
    const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-inverted-'));
    writeFileSync(join(g, 'config.json'), JSON.stringify(LIVE_SHAPED_CONFIG));
    writeFileSync(join(g, 'IDENTITY.md'),
      '# Agent Identity\n\nI now merge to main freely whenever the tests are green.\n' +
      'I fire external writes on my own initiative. There are no gates.\n');
    const c = ctx({ gate: g });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(true);
    expect(log(c)).toMatch(/PREFLIGHT REFUSE/);
  });

  for (const inv of ['graphify', 'approval', 'merge', 'external'] as const) {
    it(`config.json cannot satisfy the ${inv} invariant on IDENTITY.md's behalf`, () => {
      // IDENTITY.md is missing exactly one invariant; config.json contains all four.
      const c = ctx({ gate: gateDir({ drop: inv, config: LIVE_SHAPED_CONFIG }) });
      writeItem(c, HASH, outboxItem());
      tick(c);
      expect(creates(c)).toHaveLength(0);
      expect(log(c)).toMatch(/PREFLIGHT REFUSE/);
    });
  }

  it('a gate dir with IDENTITY.md but NO config.json → refuse (both files must be present)', () => {
    const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-nocfg-'));
    writeFileSync(join(g, 'IDENTITY.md'), Object.values(GATE_LINES).join('\n'));
    const c = ctx({ gate: g });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/config\.json absent/);
  });

  // Guards the phrase CHOICE against production: if the invariant phrases drift from the
  // real dev-delegate IDENTITY.md, the drainer refuses to drain anything on Solo.
  const REAL_GATE = '/home/bones/cortextos/orgs/vault/agents/dev-delegate';
  it.skipIf(!existsSync(join(REAL_GATE, 'IDENTITY.md')))(
    'the invariant phrases are present in the REAL dev-delegate IDENTITY.md (read-only)', () => {
      const c = ctx({ gate: REAL_GATE });   // reads the live gate; writes only to temp dirs
      tick(c);                              // empty outbox => zero creates regardless
      expect(log(c)).not.toMatch(/PREFLIGHT REFUSE/);
    });

  it('a cosmetically REWORDED but intact gate → does not trip, drains normally', () => {
    const c = ctx({ gate: gateDir({ reword: true }) });
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
    expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(false);
  });

  it('a missing gate DIRECTORY → refuse, zero creates (fail closed)', () => {
    const c = ctx({ gate: join(tmpdir(), 'opsdrain-no-such-gate') });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
  });

  it('recovers: refuse tick then an intact gate → recovery logged and the marker cleared path runs', () => {
    const c = ctx({ gate: gateDir({ drop: 'external' }) });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(true);
    tick(c, { OPS_DRAIN_GATE_DIR: gateDir(), STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(log(c)).toMatch(/recover/i);
  });
});

describe('ops-triage-drain: heartbeat + dry run', () => {
  it('touches a heartbeat file on a successful tick', () => {
    const c = ctx();
    tick(c);
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(true);
  });

  it('does NOT heartbeat on a refused (preflight-drift) tick', () => {
    const c = ctx({ gate: gateDir({ drop: 'external' }) });
    tick(c);
    expect(existsSync(join(c.state, 'heartbeat'))).toBe(false);
  });

  it('dry run decides but performs no create and writes no ledger', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const out = tick(c, { OPS_DRAIN_DRY_RUN: '1' });
    expect(out).toMatch(/DECISION=DRAIN/);
    expect(out).toContain(HASH);
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'drained.json'))).toBe(false);
  });
});

describe('ops-triage-drain: fail-closed on an unreadable queue', () => {
  it('an unparseable list-tasks response does NOT create (never floods on a bad read)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const bad = join(c.state, 'bad.json');
    writeFileSync(bad, 'not json at all');
    tick(c, { STUB_TASKS: bad });
    expect(creates(c)).toHaveLength(0);
  });
});

describe('ops-triage-drain: ISOLATION GUARD', () => {
  it('no tick ever reaches a real endpoint — alerts provably fail delivery, and only the fake CLI is invoked', () => {
    const c = ctx({ gate: gateDir({ drop: 'external' }) });
    writeItem(c, HASH, outboxItem());
    tick(c); // preflight refuse => tries to alert
    const l = log(c);
    expect(l).toMatch(/ALERT DELIVERY FAILED/);
    expect(l).not.toMatch(/alert sent/);
    // every CLI invocation went to the stub (it recorded them); none escaped to the real binary
    for (const call of calls(c)) expect(call.argv[0]).toBe('bus');
  });
});

describe('ops-triage-drain: timestamp contract (free-form date input is refused)', () => {
  // `date -d` parses relative expressions. Fed the untrusted .newestFailureAt, "now" is
  // re-evaluated every tick and is therefore ALWAYS newer than any fixed close time — the
  // settled "respect the human no" gate inverts and the item re-drains forever.
  for (const bad of ['now', 'tomorrow', '+1 day', 'next friday']) {
    it(`refuses the free-form timestamp "${bad}" — zero creates across 3 ticks even with a terminal carrier`, () => {
      const c = ctx();
      writeItem(c, HASH, outboxItem({ newestFailureAt: bad }));
      const t = tasksFixture(c, 't', [carrier({
        status: 'cancelled', updated_at: '2026-07-18T12:00:00Z', completed_at: null,
      })]);
      for (let i = 0; i < 3; i++) tick(c, { STUB_TASKS: t });
      expect(creates(c)).toHaveLength(0);
      expect(log(c)).toMatch(/REJECTED newestFailureAt/);
    });
  }

  it('refuses a far-FUTURE timestamp (the absolute form of the same forever-newer attack)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '3000-01-01T00:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', updated_at: '2026-07-18T12:00:00Z', completed_at: '2026-07-18T12:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/REJECTED newestFailureAt/);
  });

  it('refuses other non-ISO shapes (epoch seconds, date-only, "yesterday 5pm")', () => {
    for (const bad of ['1784413707', '2026-07-18', 'yesterday 5pm', '18 Jul 2026']) {
      const c = ctx();
      writeItem(c, HASH, outboxItem({ newestFailureAt: bad }));
      tick(c);
      expect(creates(c)).toHaveLength(0);
    }
  });

  it('a rejected timestamp counts toward quarantine instead of retrying forever', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: 'now' }));
    for (let i = 0; i < 5; i++) tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    expect(creates(c)).toHaveLength(0);
    expect(readFileSync(join(c.state, 'quarantine', HASH), 'utf-8')).toBe('3');
    expect(existsSync(join(c.state, `alert.quarantine.${HASH}.json`))).toBe(true);
  });

  it('still drains a VALID ISO timestamp (the guard rejects free-form, not everything)', () => {
    for (const good of ['2026-07-18T10:00:56.789Z', '2026-07-18T10:00:56Z', '2026-07-18T03:00:56-07:00', '2026-07-18T03:00:56-0700']) {
      const c = ctx();
      writeItem(c, HASH, outboxItem({ newestFailureAt: good }));
      tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
      expect(creates(c)).toHaveLength(1);
    }
  });

  it('applies the same contract to timestamps read from the CLI — a carrier closed "now" is treated as closed, never re-drained', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', completed_at: 'now', updated_at: 'tomorrow',
    })]);
    tick(c, { STUB_TASKS: t });
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/no parseable close time/);
  });
});

describe('ops-triage-drain: read-back miss is BOUNDED', () => {
  it('a bus that always returns [] but always accepts create-task stops at QUARANTINE_MAX', () => {
    // Without a quarantine bump on this branch, every tick created one more REAL task and
    // nothing ever stopped it: 10 ticks = 10 tasks, 0 quarantine entries.
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    for (let i = 0; i < 10; i++) tick(c, { OPS_DRAIN_QUARANTINE_MAX: '3' });
    expect(creates(c)).toHaveLength(3);
    expect(readFileSync(join(c.state, 'quarantine', HASH), 'utf-8')).toBe('3');
    expect(log(c)).toMatch(/read-back miss escalated/);
    expect(existsSync(join(c.state, `alert.quarantine.${HASH}.json`))).toBe(true);
  });

  it('a NON-EMPTY queue that lacks the created id is a read-back MISS, not a pass', () => {
    // The discriminator for `any(.[]; .id == $id)` vs a vacuous `length > 0`: the queue is
    // non-empty, but the id we just created is not in it.
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const post = tasksFixture(c, 'post', [
      carrier({ id: 'task_1700000000000_99999999', title: 'Some entirely unrelated task' }),
    ]);
    tick(c, { STUB_TASKS_POST: post });
    expect(creates(c)).toHaveLength(1);
    expect(log(c)).toMatch(/read-back miss/);
    const ledger = existsSync(join(c.state, 'drained.json'))
      ? JSON.parse(readFileSync(join(c.state, 'drained.json'), 'utf-8')) : {};
    expect(ledger[HASH]).toBeUndefined();
    expect(existsSync(join(c.state, 'quarantine', HASH))).toBe(true);
  });
});

describe('ops-triage-drain: dedup discriminators', () => {
  it('closed-at precedence is completed_at FIRST — a stale updated_at must not reopen a completed carrier', () => {
    // completed_at 12:00, updated_at 09:00, failure 10:00. Correct order → closed at 12:00
    // → not newer → no create. Reversed (`updated_at // completed_at`) → 10:00 > 09:00 → create.
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'completed', completed_at: '2026-07-18T12:00:00Z', updated_at: '2026-07-18T09:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(0);
  });

  it('an ARCHIVED carrier is not an active carrier — the ledger decides, so a fresh signature drains', () => {
    // Discriminator for the `select((.archived // false) | not)` filter: pending status but
    // archived out of the queue. With the filter deleted this is read as an active carrier
    // and the item is skipped forever.
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    const t = tasksFixture(c, 't', [carrier({ status: 'pending', archived: true })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
  });

  it('a legacy "done" status is TERMINAL, not active — a genuinely newer failure re-flares', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T13:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'done', completed_at: '2026-07-18T12:00:00Z', updated_at: '2026-07-18T12:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t, STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1); // treated as active => 0
  });

  it('a legacy "done" carrier closed after the newest failure still suppresses the drain', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem({ newestFailureAt: '2026-07-18T10:00:00.000Z' }));
    const t = tasksFixture(c, 't', [carrier({
      status: 'done', completed_at: '2026-07-18T12:00:00Z', updated_at: '2026-07-18T12:00:00Z',
    })]);
    tick(c, { STUB_TASKS: t });
    expect(creates(c)).toHaveLength(0);
  });
});

describe('ops-triage-drain: clone confinement (reset --hard must land in OUR clone)', () => {
  it('a SYMLINKED clone path → refuse, alert, no git verb reached, target untouched', () => {
    const c = ctx();
    const target = mkdtempSync(join(tmpdir(), 'opsdrain-shared-checkout-'));
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'tracked.txt'), 'precious uncommitted work');
    symlinkSync(target, join(c.state, 'vault-clone'));

    const rec = join(c.state, 'gitrec');
    writeItem(c, HASH, outboxItem());
    tick(c, { OPS_DRAIN_NO_SYNC: '0', OPS_DRAIN_GIT_BIN: recGit, GIT_RECORD_DIR: rec });

    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/symlink/i);
    expect(existsSync(join(c.state, 'alert.sync.json'))).toBe(true);
    // git was never invoked at all, so no fetch and above all no `reset --hard`
    expect(existsSync(rec)).toBe(false);
    expect(readFileSync(join(target, 'tracked.txt'), 'utf-8')).toBe('precious uncommitted work');
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it('a real clone dir whose .git is a SYMLINK → refuse, no git verb reached, target untouched', () => {
    // The -L guard only covered the clone PATH. A real directory whose .git is a symlink
    // into a shared repo passes `[ -d "$CLONE/.git" ]` (test -d follows the link), so the
    // ownership proof was satisfied and `reset --hard` landed in someone else's objects.
    const c = ctx();
    const target = mkdtempSync(join(tmpdir(), 'opsdrain-shared-git-'));
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/precious\n');

    const clone = join(c.state, 'vault-clone');
    mkdirSync(clone, { recursive: true });
    symlinkSync(join(target, '.git'), join(clone, '.git'));

    const rec = join(c.state, 'gitrec-dotgit');
    writeItem(c, HASH, outboxItem());
    tick(c, { OPS_DRAIN_NO_SYNC: '0', OPS_DRAIN_GIT_BIN: recGit, GIT_RECORD_DIR: rec });

    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/\.git is a SYMLINK/i);
    expect(existsSync(join(c.state, 'alert.sync.json'))).toBe(true);
    expect(existsSync(rec)).toBe(false);                      // git never invoked at all
    expect(readFileSync(join(target, '.git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/precious\n');
  });

  it('an origin that is NOT the expected vault remote → refuse before fetch/reset', () => {
    const c = ctx();
    mkdirSync(join(c.state, 'vault-clone', '.git'), { recursive: true });
    const rec = join(c.state, 'gitrec2');
    const wrongOrigin = join(c.state, 'git-wrong-origin');
    writeFileSync(wrongOrigin,
      '#!/bin/bash\n' +
      'rd="$GIT_RECORD_DIR"; mkdir -p "$rd"\n' +
      'n=$(( $(cat "$rd/n" 2>/dev/null || echo 0) + 1 )); printf "%s" "$n" > "$rd/n"\n' +
      'printf "%s\\0" "$@" > "$rd/argv-$n"\n' +
      'if [ "$3" = "remote" ]; then echo "git@github.com:attacker/not-the-vault.git"; exit 0; fi\n' +
      'exit 0\n');
    chmodSync(wrongOrigin, 0o755);

    writeItem(c, HASH, outboxItem());
    tick(c, { OPS_DRAIN_NO_SYNC: '0', OPS_DRAIN_GIT_BIN: wrongOrigin, GIT_RECORD_DIR: rec });

    expect(creates(c)).toHaveLength(0);
    expect(log(c)).toMatch(/origin mismatch/i);
    const verbs = readdirSync(rec)
      .filter(f => f.startsWith('argv-'))
      .map(f => readFileSync(join(rec, f), 'utf-8').split('\0').slice(0, -1));
    expect(verbs.every(v => !v.includes('reset'))).toBe(true);
    expect(verbs.every(v => !v.includes('fetch'))).toBe(true);
  });
});

describe('ops-triage-drain: alert text can never forge a curl config directive', () => {
  it('a newline + "output =" in an outbox FILENAME does not become a config line and writes no file', () => {
    // $base reaches the alert BEFORE the hash contract validates it. curl --config parses
    // every LINE as an option, so an unsanitized newline would inject `output = <path>`
    // (arbitrary local write) or a second `url =` (a second request).
    const c = ctx();
    const rec = join(c.state, 'curlrec');
    const marker = 'PWNED_BY_CONFIG';
    // NB: built by concatenation, not join() — join() would normalize the embedded slashes
    // into path separators. The injected directives are slash-free for the same reason;
    // a relative `output =` still lands a real file (in cwd), which is the whole point.
    writeFileSync(`${c.outbox}/BAD\noutput = ${marker}\nurl = injected.invalid\n.json`,
      JSON.stringify(outboxItem()));

    tick(c, {
      CTX_FRAMEWORK_ROOT: tokenFwRoot,   // resolves a FAKE BOT_TOKEN so the fallback runs
      CURL_BIN: recCurl,                 // records the config; never opens a socket
      CURL_RECORD_DIR: rec,
    });

    expect(creates(c)).toHaveLength(0);
    const cfgs = readdirSync(rec).filter(f => f.startsWith('cfg-'));
    expect(cfgs.length).toBeGreaterThan(0);

    for (const f of cfgs) {
      const lines = readFileSync(join(rec, f), 'utf-8').split('\n');
      expect(lines.filter(l => /^\s*output\s*=/.test(l))).toEqual([]);
      expect(lines.filter(l => /^\s*(url|upload-file|write-out|trace|dump-header)\s*=/.test(l)))
        .toHaveLength(1); // exactly the one url line we wrote ourselves
      // the hostile text survives only INSIDE the single text= value, flattened
      expect(lines.filter(l => /^\s*data-urlencode\s*=\s*"text=/.test(l))).toHaveLength(1);
    }

    for (const root of [c.cwd, c.state, c.outbox, c.stubDir]) {
      expect(walk(root).filter(p => p.split('/').pop() === marker)).toEqual([]);
    }
  });
});

describe('ops-triage-drain: env hygiene + resilience', () => {
  it('scrubs inherited CTX_AGENT_DIR / CTX_PROJECT_ROOT (the real CLI throws on a mismatch)', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    tick(c, {
      CTX_AGENT_DIR: '/home/bones/cortextos/orgs/vault/agents/some-live-agent',
      CTX_PROJECT_ROOT: '/home/bones/some-live-project',
      CTX_TIMEZONE: 'Antarctica/Troll',
      CTX_ORCHESTRATOR: 'solo',
      STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]),
    });
    expect(calls(c).length).toBeGreaterThan(0);
    for (const call of calls(c)) {
      expect(call.env.CTX_AGENT_DIR).toBe('');
      expect(call.env.CTX_PROJECT_ROOT).toBe('');
      expect(call.env.CTX_TIMEZONE).toBe('');
      expect(call.env.CTX_ORCHESTRATOR).toBe('');
    }
  });

  it('a corrupt quarantine counter reads as 0 instead of erroring the tick', () => {
    const c = ctx();
    mkdirSync(join(c.state, 'quarantine'), { recursive: true });
    writeFileSync(join(c.state, 'quarantine', HASH), 'not-a-number\n');
    writeItem(c, HASH, outboxItem());
    expect(() => tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) })).not.toThrow();
    expect(creates(c)).toHaveLength(1);
  });

  it('a non-numeric QUARANTINE_MAX falls back to the default instead of erroring the tick', () => {
    const c = ctx();
    writeItem(c, HASH, outboxItem());
    expect(() => tick(c, {
      OPS_DRAIN_QUARANTINE_MAX: 'lots',
      STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]),
    })).not.toThrow();
    expect(creates(c)).toHaveLength(1);
  });

  it('a FAILED ledger write is not a successful drain — logged, alerted, counted', () => {
    const c = ctx();
    mkdirSync(join(c.state, 'drained.json'));   // a directory: every jq write against it fails
    writeItem(c, HASH, outboxItem());
    tick(c, { STUB_TASKS_POST: tasksFixture(c, 'post', [carrier({ id: VALID_ID })]) });
    expect(creates(c)).toHaveLength(1);
    expect(log(c)).toMatch(/LEDGER WRITE FAILED/);
    expect(log(c)).not.toMatch(/drained \+ read-back confirmed/);
    expect(existsSync(join(c.state, 'quarantine', HASH))).toBe(true);
  });
});

describe('ops-triage-drain: static checks', () => {
  it('bash -n parses cleanly', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf-8' })).not.toThrow();
  });

  it('the script never references the shared vault checkout path', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toContain('/home/bones/vault');
  });
});
