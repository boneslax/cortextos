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

const TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

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
