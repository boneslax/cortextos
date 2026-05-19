import { describe, it, expect } from 'vitest';
import {
  sniffImageMime,
  canonicalExtFor,
  isAnthropicSupportedImage,
} from '../../../src/connectors/telegram/mime-sniff';

const pad = (n: number) => Buffer.alloc(n, 0);

const sigs = {
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pad(8),
  ]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad(16)]),
  gif87: Buffer.concat([Buffer.from('GIF87a'), pad(16)]),
  gif89: Buffer.concat([Buffer.from('GIF89a'), pad(16)]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x40, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    pad(16),
  ]),
  heic: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic'),
    pad(16),
  ]),
  heix: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheix'),
    pad(16),
  ]),
  mif1: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmif1'),
    pad(16),
  ]),
};

describe('sniffImageMime', () => {
  it('detects PNG', () => expect(sniffImageMime(sigs.png)).toBe('png'));
  it('detects JPEG', () => expect(sniffImageMime(sigs.jpeg)).toBe('jpeg'));
  it('detects GIF87a', () => expect(sniffImageMime(sigs.gif87)).toBe('gif'));
  it('detects GIF89a', () => expect(sniffImageMime(sigs.gif89)).toBe('gif'));
  it('detects WebP', () => expect(sniffImageMime(sigs.webp)).toBe('webp'));
  it('detects HEIC (heic brand)', () => expect(sniffImageMime(sigs.heic)).toBe('heic'));
  it('detects HEIC (heix brand)', () => expect(sniffImageMime(sigs.heix)).toBe('heic'));
  it('detects HEIC (mif1 brand)', () => expect(sniffImageMime(sigs.mif1)).toBe('heic'));

  it('returns unknown for buffers under 12 bytes', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('unknown');
  });

  it('returns unknown for arbitrary bytes', () => {
    expect(sniffImageMime(Buffer.alloc(64, 0))).toBe('unknown');
    expect(sniffImageMime(Buffer.from('hello world this is plain text'))).toBe('unknown');
  });

  it('returns unknown for ftyp with non-HEIC brand', () => {
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypmp42'),
      pad(16),
    ]);
    expect(sniffImageMime(mp4)).toBe('unknown');
  });
});

describe('canonicalExtFor', () => {
  it('maps PNG → png', () => expect(canonicalExtFor('png')).toBe('png'));
  it('maps JPEG → jpg', () => expect(canonicalExtFor('jpeg')).toBe('jpg'));
  it('maps GIF → gif', () => expect(canonicalExtFor('gif')).toBe('gif'));
  it('maps WebP → webp', () => expect(canonicalExtFor('webp')).toBe('webp'));
  it('maps HEIC → unsupported-image (non-image suffix)', () =>
    expect(canonicalExtFor('heic')).toBe('unsupported-image'));
  it('maps unknown → empty string', () =>
    expect(canonicalExtFor('unknown')).toBe(''));
});

describe('isAnthropicSupportedImage', () => {
  it('accepts png/jpeg/gif/webp', () => {
    expect(isAnthropicSupportedImage('png')).toBe(true);
    expect(isAnthropicSupportedImage('jpeg')).toBe(true);
    expect(isAnthropicSupportedImage('gif')).toBe(true);
    expect(isAnthropicSupportedImage('webp')).toBe(true);
  });
  it('rejects heic + unknown', () => {
    expect(isAnthropicSupportedImage('heic')).toBe(false);
    expect(isAnthropicSupportedImage('unknown')).toBe(false);
  });
});
