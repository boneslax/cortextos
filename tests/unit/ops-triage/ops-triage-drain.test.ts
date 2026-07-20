import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync } from 'fs';
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
let isoFwRoot: string;    // empty framework root => no agent .env => no BOT_TOKEN

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
    '  printf "CTX_AGENT_NAME=%s\\n" "${CTX_AGENT_NAME:-}"; } > "$sd/calls/call-$n.env"\n' +
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

/** A gate dir whose config.json + IDENTITY.md carry all four preflight invariants. */
function gateDir(opts: { drop?: string; reword?: boolean } = {}) {
  const g = mkdtempSync(join(tmpdir(), 'opsdrain-gate-'));
  mkdirSync(g, { recursive: true });
  let identity = opts.reword
    ? [
        'The heartbeat runs GRAPHIFY first, then a plan, then Bones approval.',
        'You must never merge anything into main.',
        'You must never fire any external writes without approval.',
      ].join('\n')
    : [
        'Heartbeat gate: graphify -> plan -> BONES APPROVAL -> build.',
        'never merge to main',
        'never fire external writes',
      ].join('\n');
  if (opts.drop) {
    identity = identity.split('\n').filter(l => !l.toLowerCase().includes(opts.drop!)).join('\n');
  }
  writeFileSync(join(g, 'IDENTITY.md'), identity + '\n');
  writeFileSync(join(g, 'config.json'), JSON.stringify({ name: 'dev-delegate' }));
  return g;
}

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
    expect(existsSync(join(c.state, 'alert.badhash.json'))).toBe(true);
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
    expect(existsSync(join(c.state, 'alert.quarantine.json'))).toBe(true);
    expect(log(c)).toMatch(/quarantin/i);
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
  it('a MISSING gate invariant → refuse, alert, zero creates', () => {
    const c = ctx({ gate: gateDir({ drop: 'external' }) });
    writeItem(c, HASH, outboxItem());
    tick(c);
    expect(creates(c)).toHaveLength(0);
    expect(existsSync(join(c.state, 'alert.preflight.json'))).toBe(true);
    expect(log(c)).toMatch(/preflight/i);
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
