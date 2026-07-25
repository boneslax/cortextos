/**
 * D1 membership-probe classifier (PLAN-v3 §5 + §7) — PURE, no I/O.
 *
 * Turns the outcome of `getChatMember(chatId, ownBotId)` into a reachability
 * verdict, encoding every correction the adversarial gate forced:
 *
 *  - Per-chat-type assertion. In a group/supergroup, `member` is NOT sufficient:
 *    privacy mode (ON by default) limits a plain member to commands/mentions.
 *    Reachable there = administrator/creator, OR member WITH
 *    can_read_all_group_messages. In a private chat, member is fine.
 *  - can_read_all_group_messages UNKNOWN (getMe failed/uncached) + member in a
 *    group => INCONCLUSIVE, never green. The unknown must not resolve in the
 *    reassuring direction — that is how six days of silence happened.
 *  - All six ChatMember statuses enumerated. `restricted` is reachable iff
 *    is_member (the restriction governs sending, not reading).
 *  - Channels are UNSUPPORTED (channel_post is not in allowed_updates) — always
 *    alert rather than pretend the probe covers them.
 *  - Three outcome classes. A = authoritative answer; C = authoritative
 *    rejection (permanent 4xx => unreachable/alert, NOT transport-debounced);
 *    B = transport-inconclusive (5xx, network, timeout, 429, 409, OR NO error
 *    code at all) => feeds only the instrument-blind alarm, never the
 *    unreachable alert.
 */

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface ProbeVerdict {
  verdict: 'reachable' | 'unreachable' | 'inconclusive';
  /** Outcome class per §7. A = authoritative answer, B = transport, C = authoritative rejection. */
  klass: 'A' | 'B' | 'C';
  /** Does this raise the UNREACHABLE alert? Never true for class B. */
  alert: boolean;
  reason: string;
}

export type ProbeInput =
  | {
      ok: true;
      chatType: ChatType;
      status: string;
      isMember?: boolean;
      canReadAllGroupMessages: boolean | undefined;
    }
  | { ok: false; errorCode: number | undefined };

const REACHABLE: ProbeVerdict = { verdict: 'reachable', klass: 'A', alert: false, reason: 'ok' };
const unreachableA = (reason: string): ProbeVerdict => ({ verdict: 'unreachable', klass: 'A', alert: true, reason });
const inconclusiveB = (reason: string): ProbeVerdict => ({ verdict: 'inconclusive', klass: 'B', alert: false, reason });

export function classifyMembershipProbe(input: ProbeInput): ProbeVerdict {
  // ---- Error path: three-class outcome (§7) --------------------------------
  if (!input.ok) {
    const code = input.errorCode;
    // No code at all (fetch failed / timeout) — carries ZERO membership
    // information. 99.85% of observed failures. MUST be B, never C.
    if (code === undefined) return inconclusiveB('transport: no error code');
    // 409 and 429 are transport even though they carry a code.
    if (code === 409) return inconclusiveB('transport: 409 conflict');
    if (code === 429) return inconclusiveB('transport: 429 rate limited');
    // Permanent 4xx (except 409/429) — authoritative rejection. Alert, do NOT
    // debounce as transport. Unclassifiable coded 4xx still lands here, alerting.
    if (code >= 400 && code <= 499) {
      return { verdict: 'unreachable', klass: 'C', alert: true, reason: `authoritative-rejection: ${code}` };
    }
    // 5xx and anything else with a code — transport-inconclusive.
    return inconclusiveB(`transport: ${code}`);
  }

  // ---- Authoritative answer path (§5) --------------------------------------
  const { chatType, status, isMember, canReadAllGroupMessages } = input;

  // Channels are unsupported: channel_post is not in allowed_updates, so an
  // admin bot in a channel is structurally deaf while status reads healthy.
  if (chatType === 'channel') return unreachableA('channel-unsupported');

  switch (status) {
    case 'creator':
    case 'administrator':
      return REACHABLE;

    case 'left':
    case 'kicked':
      return unreachableA(`status ${status}`);

    case 'restricted':
      // The restriction governs sending, not reading. Reachable iff still a member.
      return isMember ? REACHABLE : unreachableA('restricted and not a member');

    case 'member':
      if (chatType === 'private') return REACHABLE;
      // group / supergroup: member alone is NOT sufficient — privacy mode
      // (default ON) limits a plain member to commands/mentions.
      if (canReadAllGroupMessages === true) return REACHABLE;
      if (canReadAllGroupMessages === false) return unreachableA('member with privacy mode ON');
      // UNKNOWN — never resolve in the reassuring direction.
      return inconclusiveB('member in group, can_read_all_group_messages unknown');

    default:
      // An unrecognised status enum value (a future Telegram addition). Not
      // authoritative-reachable, not a hard page — inconclusive and visible.
      return inconclusiveB(`unrecognised status: ${status}`);
  }
}
