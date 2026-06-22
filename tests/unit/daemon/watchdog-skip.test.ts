import { describe, it, expect } from 'vitest';
import { shouldSkipBeforeWatchdog, isForumServiceMessage } from '../../../src/daemon/agent-manager.js';

// Bug 2: forum service messages + the agent's OWN bot messages must be dropped
// BEFORE the ALLOWED_USER watchdog counter, but a FOREIGN sender (incl. a
// foreign bot) must still fall through to the gate (and trip the watchdog).

const OWN_BOT = 7656469315;

function msg(extra: any = {}): any {
  return { message_id: 1, chat: { id: -100123, type: 'supergroup' }, ...extra };
}

describe('isForumServiceMessage', () => {
  it('true only for forum lifecycle service fields, not for message_thread_id alone', () => {
    expect(isForumServiceMessage(msg({ forum_topic_created: {} }))).toBe(true);
    expect(isForumServiceMessage(msg({ forum_topic_edited: {} }))).toBe(true);
    expect(isForumServiceMessage(msg({ general_forum_topic_hidden: {} }))).toBe(true);
    // a normal message in a topic has message_thread_id but is NOT a service msg
    expect(isForumServiceMessage(msg({ message_thread_id: 11, text: 'hi' }))).toBe(false);
    expect(isForumServiceMessage(msg({ text: 'hi' }))).toBe(false);
  });
});

describe('shouldSkipBeforeWatchdog', () => {
  it('skips a forum service message (own-bot-authored topic create)', () => {
    expect(shouldSkipBeforeWatchdog(msg({ forum_topic_created: {}, from: { id: OWN_BOT } }), OWN_BOT)).toBe('service');
  });
  it('skips a normal message authored by the agent OWN bot', () => {
    expect(shouldSkipBeforeWatchdog(msg({ from: { id: OWN_BOT }, text: 'x' }), OWN_BOT)).toBe('own-bot');
  });
  it('does NOT skip a foreign user — falls through to the gate (watchdog still applies)', () => {
    expect(shouldSkipBeforeWatchdog(msg({ from: { id: 999 }, text: 'spam' }), OWN_BOT)).toBeNull();
  });
  it('does NOT skip a FOREIGN bot — only the own bot id is excluded', () => {
    expect(shouldSkipBeforeWatchdog(msg({ from: { id: 12345, is_bot: true }, text: 'spam' }), OWN_BOT)).toBeNull();
  });
  it('with no ownBotId, only service messages skip', () => {
    expect(shouldSkipBeforeWatchdog(msg({ from: { id: OWN_BOT }, text: 'x' }), undefined)).toBeNull();
    expect(shouldSkipBeforeWatchdog(msg({ forum_topic_created: {} }), undefined)).toBe('service');
  });
});
