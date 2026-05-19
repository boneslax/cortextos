/**
 * Magic-byte image format detection for the Telegram media download
 * path. Returns the actual format of the bytes regardless of any
 * declared filename extension.
 *
 * Background: PR #446 commit ab37554a suppressed `local_file:`
 * injection on the photo path to dodge a recurring `API Error: 400
 * image/<x> not supported` crash Sam Wilson saw 4-6 hits/day across 9
 * agents. The Track 2 investigation (see
 * `pr-reviews/track2-mime-mismatch/`) showed the photo path was
 * already safe (`media.ts` hardcoded `.jpg` + Telegram server-side
 * re-encode) and the real culprit was the document path, where the
 * user-supplied `msg.document.file_name` extension reaches
 * claude-code's auto-attach with the file bytes carrying a different
 * format.
 *
 * This helper drives a sniff-and-rename in `media.ts` so the on-disk
 * filename's extension always matches the actual bytes — eliminating
 * the bytes-vs-extension mismatch that claude-code mis-labels and
 * Anthropic then rejects.
 */

export type SniffedImageMime = 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'unknown';

/**
 * Sniff the leading bytes of `buf` and return one of the known image
 * mimes or 'unknown'. 12 bytes is enough to distinguish all five
 * formats we recognize.
 */
export function sniffImageMime(buf: Buffer): SniffedImageMime {
  if (buf.length < 12) return 'unknown';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return 'gif';
  }

  // WebP: "RIFF" .... "WEBP" — "WEBP" begins at offset 8
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp';
  }

  // HEIC family: "ftyp" at offset 4, followed by a HEIC-family brand.
  // Brands per ISO/IEC 14496-12: heic, heix (still images); hevc,
  // hevx (image sequences); mif1, msf1 (HEIF containers iOS uses).
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii');
    if (
      brand === 'heic' || brand === 'heix' ||
      brand === 'hevc' || brand === 'hevx' ||
      brand === 'mif1' || brand === 'msf1'
    ) {
      return 'heic';
    }
  }

  return 'unknown';
}

/**
 * Canonical filename extension (without leading dot) for a sniffed
 * image mime. The `unsupported-image` suffix on HEIC is deliberate:
 * claude-code's auto-attach detection keys on standard image
 * extensions, so a file ending in `.unsupported-image` will be left
 * alone (no base64 → no 400 crash) and the agent can decide how to
 * surface it to the user.
 */
export function canonicalExtFor(mime: SniffedImageMime): string {
  switch (mime) {
    case 'png': return 'png';
    case 'jpeg': return 'jpg';
    case 'gif': return 'gif';
    case 'webp': return 'webp';
    case 'heic': return 'unsupported-image';
    case 'unknown': return '';
  }
}

/**
 * True iff Anthropic's vision API accepts this format. Used by the
 * document-branch rename to decide between "canonical image extension"
 * and "non-image shunt".
 */
export function isAnthropicSupportedImage(mime: SniffedImageMime): boolean {
  return mime === 'png' || mime === 'jpeg' || mime === 'gif' || mime === 'webp';
}
