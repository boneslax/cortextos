import { describe, it, expect } from 'vitest';
import { FastChecker } from '../../../src/daemon/fast-checker.js';

// Reply symmetry: when an inbound message came from a topic, the injected
// "Reply using:" instruction must carry --thread <id> so the agent's reply
// round-trips back into the same topic. When no thread, the line is unchanged.

describe('formatter reply instruction threading', () => {
  it('text: appends --thread when a threadId is present', () => {
    const out = FastChecker.formatTelegramTextMessage('Bones', '-100123', 'hi', '/tmp', undefined, undefined, undefined, 42);
    expect(out).toContain("cortextos bus send-telegram -100123 '<your reply>' --thread 42");
  });

  it('text: omits --thread when no threadId (DM/General unchanged)', () => {
    const out = FastChecker.formatTelegramTextMessage('Bones', '1664028089', 'hi', '/tmp');
    expect(out).toContain("cortextos bus send-telegram 1664028089 '<your reply>'");
    expect(out).not.toContain('--thread');
  });

  it('photo: threads the reply instruction', () => {
    const out = FastChecker.formatTelegramPhotoMessage('Bones', '-100123', 'cap', 'p.png', 7);
    expect(out).toContain("'<your reply>' --thread 7");
  });

  it('document: threads the reply instruction', () => {
    const out = FastChecker.formatTelegramDocumentMessage('Bones', '-100123', 'cap', 'd.txt', 'd.txt', 7);
    expect(out).toContain("'<your reply>' --thread 7");
  });

  it('voice: threads the reply instruction', () => {
    const out = FastChecker.formatTelegramVoiceMessage('Bones', '-100123', 'v.ogg', 5, undefined, 7);
    expect(out).toContain("'<your reply>' --thread 7");
  });

  it('video: threads the reply instruction', () => {
    const out = FastChecker.formatTelegramVideoMessage('Bones', '-100123', 'cap', 'v.mp4', 'v.mp4', 5, 7);
    expect(out).toContain("'<your reply>' --thread 7");
  });
});
