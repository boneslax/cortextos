import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveOperatorCreds } from '../../../src/daemon/operator-channel';

/**
 * PLAN-v3 §10 precondition 2 — REVISED to the one-var design.
 *
 * The two-var design (CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN) is gone:
 * the only durable place to persist daemon env is `ecosystem.config.js`, which
 * is tracked in git, so the token var would have committed a live credential.
 *
 * `CTX_OPERATOR_AGENT` names an agent instead; creds come from that agent's own
 * git-ignored `.env`. **The partial-config guard is DELETED rather than
 * narrowed** — with one non-secret var there is no half-set state left to
 * defend against, so the trap stops existing instead of being guarded forever.
 *
 * What replaces it: refuse-and-log on every failure, naming the agent, the path
 * and the specific condition. This path fires when something else is already
 * broken, so an ambiguous message is the worst possible outcome.
 */

const TOKEN = '8913497784:AAExampleToken_-';
const CHAT = '1664028089';

let root: string;

function makeAgent(org: string, agent: string, envBody: string | null): void {
  const dir = join(root, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  if (envBody !== null) writeFileSync(join(dir, '.env'), envBody);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opchan-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveOperatorCreds — the happy path', () => {
  it('reads BOT_TOKEN + CHAT_ID from the NAMED agent and reports which agent', () => {
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r).toEqual({ ok: true, creds: { chatId: CHAT, botToken: TOKEN, agent: 'solo' } });
  });

  it('reads at CALL time — a later .env edit is picked up with no restart', () => {
    // The whole feature exists because an in-memory value went stale while the
    // on-disk truth was correct. No cache: the second call sees the rotation.
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const env = { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' };
    expect(resolveOperatorCreds(root, env)).toMatchObject({ ok: true });

    const rotated = '9999999999:BBRotatedToken_-';
    writeFileSync(join(root, 'orgs/vault/agents/solo/.env'), `BOT_TOKEN=${rotated}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, env);
    expect(r.ok && r.creds.botToken).toBe(rotated);
  });
});

describe('resolveOperatorCreds — refuse, and NAME the reason', () => {
  it('unset var => refuse, never fall through to an arbitrary agent', () => {
    // Two deliverable agents exist. The old design picked the first
    // alphabetically — routing a broken-channel alert to whichever agent
    // happened to sort first delivers it where nobody is watching.
    makeAgent('vault', 'aaa-first', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_ORG: 'vault' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('unset');
    expect(r.ok === false && r.detail).toMatch(/CTX_OPERATOR_AGENT/);
  });

  it('named agent not in this org => refuse and name the path it tried', () => {
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'ghost', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('agent-not-in-org');
    expect(r.ok === false && r.detail).toMatch(/ghost/);
  });

  it('SAME-ORG ONLY — an agent in another org is not reachable', () => {
    // A misconfigured var must not be able to page another org's channel.
    makeAgent('other-org', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('agent-not-in-org');
  });

  it('CTX_ORG unset => refuse rather than guess an org', () => {
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo' });
    expect(r.ok === false && r.reason).toBe('agent-not-in-org');
    expect(r.ok === false && r.detail).toMatch(/CTX_ORG/);
  });

  it('rejects a path-traversing agent name instead of reading outside the org', () => {
    // The value indexes into orgs/<org>/agents/<name>.
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: '../../../etc', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('invalid-agent-name');
  });

  it('agent dir exists but no .env => env-unreadable, naming the file', () => {
    makeAgent('vault', 'solo', null);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('env-unreadable');
    expect(r.ok === false && r.detail).toMatch(/\.env/);
  });
});

describe('resolveOperatorCreds — a torn .env names WHICH key is missing', () => {
  it('CHAT_ID present, BOT_TOKEN missing', () => {
    makeAgent('vault', 'solo', `CHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('env-torn');
    expect(r.ok === false && r.detail).toMatch(/no BOT_TOKEN/);
  });

  it('BOT_TOKEN present, CHAT_ID missing', () => {
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('env-torn');
    expect(r.ok === false && r.detail).toMatch(/no CHAT_ID/);
  });

  it('neither key present', () => {
    makeAgent('vault', 'solo', 'SOMETHING_ELSE=1\n');
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('env-torn');
    expect(r.ok === false && r.detail).toMatch(/neither/);
  });

  it('malformed BOT_TOKEN is torn, NOT a usable pair', () => {
    // A syntactically wrong token would fail at send time — inside the alert
    // path, silently. Catch it at resolution instead.
    makeAgent('vault', 'solo', `BOT_TOKEN=not-a-token\nCHAT_ID=${CHAT}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok === false && r.reason).toBe('env-torn');
    expect(r.ok === false && r.detail).toMatch(/malformed/);
  });

  it('never leaks the token value in the failure detail', () => {
    makeAgent('vault', 'solo', `BOT_TOKEN=${TOKEN}\n`);
    const r = resolveOperatorCreds(root, { CTX_OPERATOR_AGENT: 'solo', CTX_ORG: 'vault' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.detail).not.toContain(TOKEN);
  });
});
