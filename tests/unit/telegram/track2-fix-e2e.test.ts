/**
 * Track 2 mime-mismatch — end-to-end fix verification.
 *
 * The Stage 2/Stage 4 unit tests cover sniff helpers + media.ts
 * branch behavior in isolation. This file pulls the pieces together
 * and verifies the full pipeline produces safe agent prompts for the
 * five fixture cases AND that the photo path round-trips correctly
 * post-revert of ab37554a.
 *
 * "Safe" means: any path that appears in a `local_file:` injection
 * line carries an extension that matches the actual bytes (or the
 * `.unsupported-image` shunt for HEIC). claude-code's auto-attach
 * will read the file, base64-encode, and label the mime from the
 * extension; with a matching extension the label and bytes agree and
 * Anthropic accepts the image without 400.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join, extname, basename } from 'path';
import { tmpdir } from 'os';
import { processMediaMessage } from '../../../src/telegram/media';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { sniffImageMime } from '../../../src/connectors/telegram/mime-sniff';
import type { TelegramMessage } from '../../../src/types';

function createMockApi(filePath: string, fileData: Buffer) {
  return {
    getFile: vi.fn().mockResolvedValue({ result: { file_path: filePath } }),
    downloadFile: vi.fn().mockResolvedValue(fileData),
  } as any;
}

function makeDocMsg(fileName: string): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 42, type: 'private' },
    from: { id: 1, first_name: 'Alice' },
    document: { file_id: 'doc1', file_name: fileName },
    caption: '',
  };
}

function makePhotoMsg(): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 42, type: 'private' },
    from: { id: 1, first_name: 'Alice' },
    photo: [{ file_id: 'large', width: 800, height: 600 }],
  };
}

const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic'),
  Buffer.alloc(64, 0),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.alloc(16, 0),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0),
]);

describe('Track 2 end-to-end: agent prompts carry sniff-correct paths', () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'track2-e2e-'));
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
  });

  it('document with PNG-labeled JPEG bytes: prompt local_file ends in .jpg', async () => {
    const msg = makeDocMsg('screenshot.png');
    const api = createMockApi('documents/x.bin', JPEG);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramDocumentMessage(
      'Alice', '42', '', media.file_path!, media.file_name!,
    );
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    expect(extname(pathLine)).toBe('.jpg');
  });

  it('document with HEIC-labeled .jpg bytes: prompt local_file ends in .unsupported-image (auto-attach suppressed)', async () => {
    const msg = makeDocMsg('IMG_0042.jpg');
    const api = createMockApi('documents/x.bin', HEIC);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramDocumentMessage(
      'Alice', '42', '', media.file_path!, media.file_name!,
    );
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    expect(extname(pathLine)).toBe('.unsupported-image');
  });

  it('document with GIF-labeled .png bytes: prompt local_file ends in .gif', async () => {
    const msg = makeDocMsg('anim.png');
    const api = createMockApi('documents/x.bin', GIF);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramDocumentMessage(
      'Alice', '42', '', media.file_path!, media.file_name!,
    );
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    expect(extname(pathLine)).toBe('.gif');
  });

  it('document with WebP-labeled .png bytes: prompt local_file ends in .webp', async () => {
    const msg = makeDocMsg('sticker.png');
    const api = createMockApi('documents/x.bin', WEBP);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramDocumentMessage(
      'Alice', '42', '', media.file_path!, media.file_name!,
    );
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    expect(extname(pathLine)).toBe('.webp');
  });

  it('photo with JPEG bytes: prompt local_file ends in .jpg (post-revert of ab37554a)', async () => {
    const msg = makePhotoMsg();
    const api = createMockApi('photos/file_AAAAAAAAAAA.jpg', JPEG);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramPhotoMessage(
      'Alice', '42', '', media.image_path!,
    );
    // Post-revert: local_file: line is back. Auto-attach safe because
    // sniff confirmed JPEG bytes matched .jpg extension.
    expect(prompt).toContain(`local_file: ${media.image_path}`);
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    expect(extname(pathLine)).toBe('.jpg');
    // The suppression marker is GONE.
    expect(prompt).not.toContain('[image attached');
  });

  it('photo with PNG bytes (CDN drift): defensive sniff routes to .png; prompt is safe', async () => {
    const msg = makePhotoMsg();
    const api = createMockApi('photos/file_AAAAAAAAAAA.jpg', PNG);
    const media = (await processMediaMessage(msg, api, downloadDir))!;
    const prompt = FastChecker.formatTelegramPhotoMessage(
      'Alice', '42', '', media.image_path!,
    );
    expect(prompt).toContain(`local_file: ${media.image_path}`);
    const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
    // Bytes are PNG → sniff overrides hardcoded .jpg → ext matches bytes.
    expect(extname(pathLine)).toBe('.png');
  });

  it('all-fixtures invariant: every produced local_file extension matches sniffed bytes (or .unsupported-image)', async () => {
    const cases: Array<{ name: string; bytes: Buffer; declaredExt: string }> = [
      { name: 'heic_as_jpg', bytes: HEIC, declaredExt: '.jpg' },
      { name: 'gif_as_png', bytes: GIF, declaredExt: '.png' },
      { name: 'webp_as_png', bytes: WEBP, declaredExt: '.png' },
      { name: 'jpeg_as_png', bytes: JPEG, declaredExt: '.png' },
      { name: 'png_control', bytes: PNG, declaredExt: '.png' },
    ];

    for (const c of cases) {
      const msg = makeDocMsg(`file${c.declaredExt}`);
      const api = createMockApi('documents/x.bin', c.bytes);
      const media = (await processMediaMessage(msg, api, downloadDir))!;
      const prompt = FastChecker.formatTelegramDocumentMessage(
        'Alice', '42', '', media.file_path!, media.file_name!,
      );
      const pathLine = prompt.split('\n').find((l) => l.startsWith('local_file:'))!;
      const ext = extname(pathLine);
      const sniffed = sniffImageMime(c.bytes);

      if (sniffed === 'heic') {
        expect(ext).toBe('.unsupported-image');
      } else if (sniffed === 'png') {
        expect(ext).toBe('.png');
      } else if (sniffed === 'jpeg') {
        expect(ext).toBe('.jpg');
      } else if (sniffed === 'gif') {
        expect(ext).toBe('.gif');
      } else if (sniffed === 'webp') {
        expect(ext).toBe('.webp');
      }
    }
  });
});
