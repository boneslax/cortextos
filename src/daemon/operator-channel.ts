/**
 * Operator alert-channel resolution (PLAN-v3 §10, precondition 2).
 *
 * The operator channel is the out-of-band route for "your Telegram is broken"
 * alerts. It must not depend on the channel it reports on.
 *
 * ## Why ONE non-secret var (supersedes the two-var design)
 *
 * The original design took `CTX_OPERATOR_CHAT_ID` + `CTX_OPERATOR_BOT_TOKEN`.
 * That could not be made durable: the only persistence path for daemon env is
 * `ecosystem.config.js`, which is **tracked in git** — so the token var would
 * have committed a live credential. Exporting it in a shell instead dies on a
 * reboot or a pm2 resurrect.
 *
 * So the channel is NAMED, not carried. **`CTX_OPERATOR_AGENT`** holds an agent
 * name — not a secret, safe in a tracked file — and the creds are read from that
 * agent's own `.env`: the single existing copy, already git-ignored and mode
 * 600. Zero secret duplication, nothing to paste, survives reboots.
 *
 * ## Read at ALERT time, never cached
 *
 * This feature exists because an in-memory value went stale while the on-disk
 * truth was correct. A cache here would re-introduce exactly that, in the
 * alerting path, where a stale read means the alert goes nowhere and nothing
 * says so. Alerts are an exception path, not a hot path — one small file read
 * per alert is free.
 *
 * ## Refuse, never fall through
 *
 * There is no "first agent alphabetically" fallback and no override vars. The
 * partial-config guard that defended the old two-var design is gone with it:
 * the trap no longer exists rather than being defended. Every failure returns a
 * typed reason and names the agent, the path, and the specific condition — this
 * path fires when something else is already broken, which is the worst possible
 * moment for an ambiguous message.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
/**
 * Cheap first filter only. NOT the security boundary — `.` is in the class, so
 * `..` passes this and resolves one level UP out of the agents dir. Containment
 * is proven below by resolving the path and asserting it is still inside
 * `orgs/<org>/agents/`: a name pattern is a blocklist you keep guessing at,
 * path containment is a property you can prove.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface OperatorCreds {
  chatId: string;
  botToken: string;
  /** Which agent's channel this resolved to — for logging; never a secret. */
  agent: string;
}

export type OperatorFailure =
  | 'unset'
  | 'invalid-agent-name'
  | 'agent-not-in-org'
  | 'env-unreadable'
  | 'env-torn';

export type OperatorResolution =
  | { ok: true; creds: OperatorCreds }
  | { ok: false; reason: OperatorFailure; detail: string };

/**
 * Resolve the operator alert channel from `CTX_OPERATOR_AGENT`.
 *
 * Scoped to the CURRENT org only — a misconfigured var must not reach another
 * org's channel. `env` is injectable so this is testable under the
 * CTX_*-stripping clean room.
 */
export function resolveOperatorCreds(
  frameworkRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): OperatorResolution {
  const agent = env.CTX_OPERATOR_AGENT?.trim() || '';
  const org = env.CTX_ORG?.trim() || '';

  if (!agent) {
    return {
      ok: false,
      reason: 'unset',
      detail:
        'CTX_OPERATOR_AGENT is not set — no operator alert channel is configured. ' +
        'Set it to an agent name in this org (e.g. "solo"); that agent\'s own .env supplies BOT_TOKEN + CHAT_ID.',
    };
  }

  if (!AGENT_NAME_RE.test(agent)) {
    return {
      ok: false,
      reason: 'invalid-agent-name',
      detail: `CTX_OPERATOR_AGENT="${agent}" is not a valid agent name (expected [A-Za-z0-9._-]+).`,
    };
  }

  if (!org) {
    return {
      ok: false,
      reason: 'agent-not-in-org',
      detail: `CTX_OPERATOR_AGENT="${agent}" cannot be resolved: CTX_ORG is not set, so there is no org to look in.`,
    };
  }

  const agentsRoot = resolve(frameworkRoot, 'orgs', org, 'agents');
  const agentDir = resolve(agentsRoot, agent);

  // Containment, proven rather than pattern-matched. `..` and `.` satisfy the
  // regex above; only this check stops them resolving outside the agents dir
  // (e.g. `..` -> orgs/<org>/, which sits beside real org-level env files).
  if (agentDir !== agentsRoot && !agentDir.startsWith(agentsRoot + sep)) {
    return {
      ok: false,
      reason: 'invalid-agent-name',
      detail: `CTX_OPERATOR_AGENT="${agent}" resolves outside the agents directory (${agentsRoot}) — refusing.`,
    };
  }
  if (agentDir === agentsRoot) {
    return {
      ok: false,
      reason: 'invalid-agent-name',
      detail: `CTX_OPERATOR_AGENT="${agent}" resolves to the agents directory itself, not an agent.`,
    };
  }

  const envFile = join(agentDir, '.env');

  if (!existsSync(agentDir)) {
    return {
      ok: false,
      reason: 'agent-not-in-org',
      detail: `CTX_OPERATOR_AGENT="${agent}" is not an agent in org "${org}" (looked for ${agentDir}).`,
    };
  }

  let content: string;
  try {
    if (!existsSync(envFile) || !statSync(envFile).isFile()) {
      return {
        ok: false,
        reason: 'env-unreadable',
        detail: `Operator agent "${agent}" has no readable .env at ${envFile}.`,
      };
    }
    content = readFileSync(envFile, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      reason: 'env-unreadable',
      detail: `Operator agent "${agent}" .env could not be read (${envFile}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  const botToken = content.match(/^BOT_TOKEN=(.+)$/m)?.[1]?.trim() || '';
  const chatId = content.match(/^CHAT_ID=(.+)$/m)?.[1]?.trim() || '';

  // "Torn" = the file exists but carries no usable, coherent pair. Name WHICH
  // key is missing rather than reporting a generic failure.
  if (!botToken && !chatId) {
    return {
      ok: false,
      reason: 'env-torn',
      detail: `Operator agent "${agent}" .env (${envFile}) has neither BOT_TOKEN nor CHAT_ID.`,
    };
  }
  if (!botToken) {
    return {
      ok: false,
      reason: 'env-torn',
      detail: `Operator agent "${agent}" .env (${envFile}) has CHAT_ID but no BOT_TOKEN.`,
    };
  }
  if (!chatId) {
    return {
      ok: false,
      reason: 'env-torn',
      detail: `Operator agent "${agent}" .env (${envFile}) has BOT_TOKEN but no CHAT_ID.`,
    };
  }
  if (!TOKEN_RE.test(botToken)) {
    return {
      ok: false,
      reason: 'env-torn',
      detail: `Operator agent "${agent}" .env (${envFile}) has a malformed BOT_TOKEN.`,
    };
  }

  return { ok: true, creds: { chatId, botToken, agent } };
}
