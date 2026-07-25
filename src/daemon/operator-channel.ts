/**
 * Operator alert-channel config guard (PLAN-v3 §10, precondition 2) — PURE.
 *
 * The operator channel (CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN) is the
 * out-of-band route for "your Telegram is broken" alerts — it must not depend on
 * the very channel it reports on. The trap: PARTIAL configuration is worse than
 * none. If only CTX_OPERATOR_CHAT_ID is set, the legacy fallback pairs the
 * operator chat id with the FIRST AGENT'S bot token — a bot that is not in that
 * chat — so every alert fails SILENTLY while looking configured.
 *
 * Rule: if EITHER var is present, require BOTH and validate BOTH. Half-set is a
 * config ERROR, not a fall-through.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

export interface OperatorCreds {
  chatId: string;
  botToken: string;
}

export type OperatorResolution =
  | { ok: true; creds: OperatorCreds }
  | { ok: false; reason: 'partial' | 'absent'; detail?: string };

export type OperatorConfig =
  | { kind: 'complete'; chatId: string; botToken: string }
  | { kind: 'partial'; reason: string }
  | { kind: 'absent' };

export function classifyOperatorEnv(
  envChat: string | undefined,
  envToken: string | undefined,
): OperatorConfig {
  const chat = envChat?.trim() || '';
  const token = envToken?.trim() || '';

  // Neither present — the caller may (for non-alert uses) fall back. Liveness
  // alerts refuse the fallback separately (§10).
  if (!chat && !token) return { kind: 'absent' };

  // At least one present => require BOTH, valid.
  if (!chat) return { kind: 'partial', reason: 'CTX_OPERATOR_BOT_TOKEN set but CTX_OPERATOR_CHAT_ID missing' };
  if (!token) return { kind: 'partial', reason: 'CTX_OPERATOR_CHAT_ID set but CTX_OPERATOR_BOT_TOKEN missing' };
  if (!TOKEN_RE.test(token)) return { kind: 'partial', reason: 'CTX_OPERATOR_BOT_TOKEN is malformed' };

  return { kind: 'complete', chatId: chat, botToken: token };
}

/**
 * Resolve operator-alert-channel creds (PLAN-v3 §10). `env` is injectable so it
 * is testable under the CTX_*-stripping clean room.
 *
 *  - complete CTX_OPERATOR  => use it.
 *  - partial CTX_OPERATOR    => { ok:false, reason:'partial' } — REFUSE, never
 *    cross-wire (a half-set config is a startup error, not a fall-through).
 *  - absent + allowAgentFallback => first agent's own {chat, token} (a coherent,
 *    deliverable pair — only when CTX_OPERATOR is entirely unset).
 *  - absent + !allowAgentFallback (liveness alerts) => { ok:false, reason:'absent' }.
 *    The alert about a broken channel must not ride an agent's own channel.
 */
export function resolveOperatorCreds(
  frameworkRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowAgentFallback?: boolean } = {},
): OperatorResolution {
  const allowAgentFallback = opts.allowAgentFallback ?? true;
  const cfg = classifyOperatorEnv(env.CTX_OPERATOR_CHAT_ID, env.CTX_OPERATOR_BOT_TOKEN);
  if (cfg.kind === 'complete') return { ok: true, creds: { chatId: cfg.chatId, botToken: cfg.botToken } };
  if (cfg.kind === 'partial') return { ok: false, reason: 'partial', detail: cfg.reason };

  // Absent. Liveness alerts require the dedicated operator channel.
  if (!allowAgentFallback) return { ok: false, reason: 'absent' };

  // Priority 2: first agent's own .env (coherent chat+token pair).
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return { ok: false, reason: 'absent' };
    for (const org of readdirSync(orgsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      for (const a of readdirSync(agentsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          const content = readFileSync(envFile, 'utf-8');
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = chatMatch[1].trim();
          if (TOKEN_RE.test(botToken)) return { ok: true, creds: { chatId, botToken } };
        } catch {
          /* skip this agent */
        }
      }
    }
  } catch {
    /* fall through */
  }
  return { ok: false, reason: 'absent' };
}
