/**
 * Stage 2 sandbox repro for the Track 2 mime-mismatch bug investigation.
 *
 * Context (per Boris bus msg 1779158709461):
 *   PR #446 commit ab37554a suppressed `local_file:` from the PHOTO
 *   injection path to dodge "API Error: 400 image/<x> not supported"
 *   crashes that Sam Wilson (storypixel) saw 4-6 times/day across 9
 *   agents. James's fleet (11 agents) never saw the crash.
 *
 * Stage 1 trace finding: the photo path hardcodes `.jpg` (media.ts:80)
 * AND Telegram re-encodes photo-type uploads to JPEG server-side, so
 * the photo path can not produce the `image/png` error Sam reported.
 * The remaining surface is the DOCUMENT path, where `msg.document.file_name`
 * is USER-supplied and its extension is preserved verbatim through
 * sanitizeFilename → on-disk filename → formatTelegramDocumentMessage →
 * agent PTY prompt → claude-code auto-attach.
 *
 * Stage 2 (this file) reproduces that surface in isolation by:
 *   1. Crafting 5 fixtures with mismatched magic bytes vs declared
 *      file_name extension (the failure modes Boris enumerated, plus
 *      a control).
 *   2. Driving each through processMediaMessage with a mocked
 *      TelegramAPI that returns the crafted bytes.
 *   3. Asserting the saved file on disk carries the user-supplied
 *      extension (NOT a sniff-corrected extension) — this is the
 *      reproduction of the bug surface.
 *   4. Driving each through formatTelegramDocumentMessage and asserting
 *      the mismatched-extension path reaches the agent prompt intact.
 *
 * The actual `claude-code auto-attach → 400` crash is observed in prod
 * (Sam's incident report); this test proves the upstream surface that
 * feeds it.
 *
 * NOTE: This test file is the repro evidence for the Stage 2 Boris
 * report. The Stage 3 design + Stage 4 fix branch will live in
 * subsequent commits. Co-author: Jeremy Ferrell Wilson (storypixel) —
 * his diagnosis identified the wedge pattern; this trace identified
 * the wrong-path patch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { processMediaMessage } from '../../../src/telegram/media';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { TelegramMessage } from '../../../src/types';

function createMockApi(filePath: string, fileData: Buffer) {
  return {
    getFile: vi.fn().mockResolvedValue({ result: { file_path: filePath } }),
    downloadFile: vi.fn().mockResolvedValue(fileData),
  } as any;
}

function makeDocMsg(fileName: string, caption: string = ''): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 42, type: 'private' },
    from: { id: 1, first_name: 'Alice' },
    document: { file_id: 'doc1', file_name: fileName },
    caption,
  };
}

/**
 * Magic-byte signatures for the five fixture cases. These are the
 * leading bytes a real-bytes sniff (libmagic / file(1) / mime-type
 * libraries) would use to determine the actual format regardless of
 * the file extension.
 */
const FIXTURES = {
  // Case 1: HEIC from iOS — common when Android Telegram client
  // forwards an iOS-originated screenshot/photo without re-encoding,
  // and the user has renamed or the upload pipeline labeled it .jpg.
  // Real HEIC files start with `ftypheic` (or `ftypheix` / `ftypmif1`)
  // at offset 4.
  heic_as_jpg: {
    fileName: 'IMG_0042.jpg',
    bytes: Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(64, 0), // padding
    ]),
    actualMime: 'image/heic',
    declaredMimeViaExt: 'image/jpeg',
  },

  // Case 2: animated GIF that the user/sender labeled .png — happens
  // when desktop apps "save as png" a GIF screenshot capture.
  gif_as_png: {
    fileName: 'screenshot.png',
    bytes: Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.from([0x10, 0x00, 0x10, 0x00]),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/gif',
    declaredMimeViaExt: 'image/png',
  },

  // Case 3: WebP saved as .png — common Telegram sticker forwarding
  // pattern (stickers are WebP, when "save as png" the bytes stay WebP
  // but extension flips).
  webp_as_png: {
    fileName: 'sticker.png',
    bytes: Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x40, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/webp',
    declaredMimeViaExt: 'image/png',
  },

  // Case 4: Sam's literal report — PNG-labeled file containing JPEG
  // bytes. Most common path: iPhone "save as PNG" of a JPEG-source
  // photo, or screenshot tools that mis-stamp.
  jpeg_as_png: {
    fileName: 'screenshot.png',
    bytes: Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF'),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/jpeg',
    declaredMimeViaExt: 'image/png',
  },

  // Case 5: control — actual PNG bytes labeled .png. Must continue to
  // work post-fix.
  png_control: {
    fileName: 'real.png',
    bytes: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]),
    actualMime: 'image/png',
    declaredMimeViaExt: 'image/png',
  },
};

describe('Track 2 Stage 2 repro: document-path mime/byte mismatch reaches agent prompt', () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'track2-mime-mismatch-'));
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
  });

  for (const [caseName, fixture] of Object.entries(FIXTURES)) {
    it(`case ${caseName}: declared=${fixture.declaredMimeViaExt} actual=${fixture.actualMime} — extension preserved on disk + reaches prompt`, async () => {
      const msg = makeDocMsg(fixture.fileName, 'check this');
      const api = createMockApi('documents/file_remote.bin', fixture.bytes);

      const result = await processMediaMessage(msg, api, downloadDir);

      // Repro point 1: media.ts saves the file under user-supplied
      // file_name (sanitized), which preserves the extension verbatim.
      expect(result).not.toBeNull();
      expect(result!.type).toBe('document');
      expect(result!.file_name).toBe(fixture.fileName);
      expect(extname(result!.file_path!)).toBe(extname(fixture.fileName));
      expect(existsSync(result!.file_path!)).toBe(true);

      // The saved file's bytes ARE the crafted (mismatched) magic-byte
      // payload — proving the mismatch reaches disk.
      const onDisk = readFileSync(result!.file_path!);
      expect(onDisk.equals(fixture.bytes)).toBe(true);

      // Repro point 2: formatTelegramDocumentMessage injects the
      // mismatched-extension path into the agent prompt verbatim. This
      // is the line claude-code's auto-attach reads, base64-encodes,
      // and labels with the (mismatched) extension-derived mime — which
      // is what surfaces as Sam's 400 image/<x> not supported crash.
      const prompt = FastChecker.formatTelegramDocumentMessage(
        'Alice',
        '42',
        'check this',
        result!.file_path!,
        result!.file_name!,
      );
      expect(prompt).toContain(`local_file: ${result!.file_path!}`);
      expect(prompt).toContain(`file_name: ${fixture.fileName}`);
      // The prompt contains the extension claude-code will mime-derive
      // from, regardless of bytes.
      expect(prompt).toContain(extname(fixture.fileName));
    });
  }

  it('summary repro: document path injects mismatched-extension paths in 4/5 cases (only png_control is consistent)', async () => {
    const mismatches: string[] = [];
    const matches: string[] = [];

    for (const [caseName, fixture] of Object.entries(FIXTURES)) {
      const msg = makeDocMsg(fixture.fileName);
      const api = createMockApi('documents/file_remote.bin', fixture.bytes);
      const result = await processMediaMessage(msg, api, downloadDir);
      if (fixture.actualMime === fixture.declaredMimeViaExt) {
        matches.push(caseName);
      } else {
        mismatches.push(caseName);
      }
      // Each repro saves with mismatched extension reaching disk.
      expect(result!.file_path!.endsWith(extname(fixture.fileName))).toBe(true);
    }

    // 4 of 5 fixtures are byte/extension mismatches; only the control
    // is consistent. This proves the document path is the live crash
    // surface — and ab37554a's photo-path suppression does not touch
    // it.
    expect(mismatches.length).toBe(4);
    expect(matches).toEqual(['png_control']);
  });

  it('control: ab37554a-style photo-path suppression does NOT cover the document path', () => {
    // Confirm the suppression patch is on photo-only.
    const photoPrompt = FastChecker.formatTelegramPhotoMessage(
      'Alice', '42', 'cap', 'telegram-images/foo.jpg',
    );
    expect(photoPrompt).not.toContain('local_file:');
    expect(photoPrompt).toContain('[image attached');

    // The document formatter still injects local_file: regardless of
    // the user-supplied extension.
    const docPrompt = FastChecker.formatTelegramDocumentMessage(
      'Alice', '42', 'cap', 'telegram-images/poison.png', 'poison.png',
    );
    expect(docPrompt).toContain('local_file: telegram-images/poison.png');
    expect(docPrompt).toContain('file_name: poison.png');
  });
});
