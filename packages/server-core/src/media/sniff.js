/**
 * File-signature ("magic byte") detection and image dimension parsing, with no native dependencies.
 * The client-declared MIME type and filename are never trusted; only these checks decide what a file is.
 */

const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

/**
 * @param {Buffer} head first bytes of the file (>= 64 recommended)
 * @returns {{mime: string, kind: 'image'|'video'}|null}
 */
export function detectMedia(head) {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'image' };
  const ascii6 = head.subarray(0, 6).toString('latin1');
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') return { mime: 'image/gif', kind: 'image' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', kind: 'image' };
  }
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (IMAGE_BRANDS.has(brand) || brand === 'qt  ') return null; // HEIF/AVIF stills, QuickTime: not accepted
    return { mime: 'video/mp4', kind: 'video' };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML: WebM or Matroska. Only WebM is accepted.
    if (head.subarray(0, Math.min(head.length, 64)).includes(Buffer.from('webm'))) return { mime: 'video/webm', kind: 'video' };
    return null;
  }
  return null;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** @returns {{width: number, height: number}|null} */
export function readImageSize(buf, mime) {
  try {
    switch (mime) {
      case 'image/png':
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case 'image/gif':
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case 'image/webp':
        return readWebpSize(buf);
      case 'image/jpeg':
        return readJpegSize(buf);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function readWebpSize(buf) {
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  return null;
}

function readJpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1];
    while (marker === 0xff) marker = buf[++i + 1]; // padding
    if (SOF_MARKERS.has(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
