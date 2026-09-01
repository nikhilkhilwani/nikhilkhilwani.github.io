/**
 * Surgical metadata removal: rebuild the container without the segments that
 * carry metadata, leaving every other byte exactly where it was.
 *
 * The alternative — drawing the image to a canvas and re-exporting — is three
 * lines and wrong. It recompresses (permanent loss, compounding on every pass),
 * discards the colour profile so the image shifts, and needs the whole bitmap
 * in memory. Copying byte ranges instead means the entropy-coded image data is
 * IDENTICAL afterwards, which the tests assert directly.
 *
 * One subtlety decides whether this tool is usable: EXIF Orientation. A phone
 * stores landscape pixels plus "rotate 90°". Remove the EXIF and every viewer
 * shows the photo on its side — privacy fixed, photo visibly broken. So when
 * orientation is the only thing standing between correct display and a sideways
 * image, a minimal Exif block containing nothing but Orientation is written
 * back: 26 bytes of TIFF, no device, no place, no time.
 */

import {
  categoryOf,
  crc32,
  VP8X_FLAGS,
  walkContainer,
  type Segment,
  type StripCategory,
} from './containers.ts';
import { orientationFrom, readTiff } from './tags.ts';

export interface StripOptions {
  exif?: boolean;
  xmp?: boolean;
  iptc?: boolean;
  comments?: boolean;
  /** Vendor blocks, appended images, and other unrecognised metadata. */
  other?: boolean;
  /** Off by default: the colour profile is not identifying, and removing it
   *  changes how the image renders. */
  icc?: boolean;
  /** On by default. See the note above — this is the difference between a
   *  cleaned photo and a sideways one. */
  keepOrientation?: boolean;
}

export interface RemovedBlock {
  where: string;
  kind: string;
  bytes: number;
}

export type StripOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      removed: RemovedBlock[];
      bytesRemoved: number;
      /** The orientation written back, or null when none was needed. */
      orientationPreserved: number | null;
      warnings: string[];
    }
  | { ok: false; reason: string };

const DEFAULTS: Required<StripOptions> = {
  exif: true,
  xmp: true,
  iptc: true,
  comments: true,
  other: true,
  icc: false,
  keepOrientation: true,
};

function wants(options: Required<StripOptions>, category: StripCategory): boolean {
  switch (category) {
    case 'exif':
      return options.exif;
    case 'xmp':
      return options.xmp;
    case 'iptc':
      return options.iptc;
    case 'comments':
      return options.comments;
    case 'other':
      return options.other;
    case 'icc':
      return options.icc;
  }
}

/* -------------------------------------------------------------------------- */
/* The minimal Exif block                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A complete TIFF structure holding one tag. 26 bytes:
 * header (8) + entry count (2) + one entry (12) + next-IFD link (4).
 */
export function minimalOrientationTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out[0] = 0x4d;
  out[1] = 0x4d; // 'MM', big-endian
  view.setUint16(2, 42);
  view.setUint32(4, 8); // IFD0 begins immediately after the header
  view.setUint16(8, 1); // exactly one entry
  view.setUint16(10, 0x0112); // Orientation
  view.setUint16(12, 3); // SHORT
  view.setUint32(14, 1); // one value
  // A SHORT occupies two of the entry's four value bytes, left-aligned.
  view.setUint16(18, orientation);
  view.setUint32(22, 0); // no further IFD, so no thumbnail
  return out;
}

/** The same block wrapped as a JPEG APP1 segment. */
function orientationApp1(orientation: number): Uint8Array {
  const tiff = minimalOrientationTiff(orientation);
  const out = new Uint8Array(4 + 6 + tiff.length);
  out[0] = 0xff;
  out[1] = 0xe1;
  // The length counts itself plus the payload, but not the marker.
  const length = 2 + 6 + tiff.length;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4); // 'Exif\0\0'
  out.set(tiff, 10);
  return out;
}

/** The same block as a PNG eXIf chunk, checksum included. */
function orientationExifChunk(orientation: number): Uint8Array {
  const tiff = minimalOrientationTiff(orientation);
  const out = new Uint8Array(12 + tiff.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, tiff.length);
  out.set([0x65, 0x58, 0x49, 0x66], 4); // 'eXIf'
  out.set(tiff, 8);
  // PNG checksums the type and data together, excluding the length.
  view.setUint32(8 + tiff.length, crc32(out.subarray(4, 8 + tiff.length)));
  return out;
}

/** The same block as a WebP EXIF chunk. */
function orientationWebpChunk(orientation: number): Uint8Array {
  const tiff = minimalOrientationTiff(orientation);
  // 26 is even, so no pad byte is needed.
  const out = new Uint8Array(8 + tiff.length);
  out.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
  const view = new DataView(out.buffer);
  view.setUint32(4, tiff.length, true); // RIFF sizes are little-endian
  out.set(tiff, 8);
  return out;
}

/* -------------------------------------------------------------------------- */

function concat(pieces: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

/**
 * Reads the orientation out of whichever segment carries the Exif block, so it
 * can be written back after that segment is dropped.
 */
function orientationOf(bytes: Uint8Array, segments: Segment[]): number | null {
  const exif = segments.find((segment) => segment.kind === 'exif');
  if (!exif) return null;
  const tiff = readTiff(bytes, exif.payloadStart);
  if (!tiff) return null;
  return orientationFrom(tiff.entries);
}

export function stripMetadata(input: Uint8Array, options: StripOptions = {}): StripOutcome {
  const settings: Required<StripOptions> = { ...DEFAULTS, ...options };

  const walk = walkContainer(input);
  if (!walk) return { ok: false, reason: 'This file is not an image format the tool recognises.' };
  if (!walk.rewritable) {
    return {
      ok: false,
      reason:
        walk.container === 'heic' || walk.container === 'avif'
          ? 'HEIC and AVIF keep metadata inside a box tree of absolute offsets, which this tool can read but not yet rewrite.'
          : `Metadata cannot be removed from ${walk.container.toUpperCase()} files yet.`,
    };
  }

  const warnings = [...walk.warnings];
  const removed: RemovedBlock[] = [];

  // Orientation has to be read before the block holding it is discarded.
  const droppingExif = settings.exif;
  const existing = droppingExif ? orientationOf(input, walk.segments) : null;
  const needsOrientation =
    settings.keepOrientation && existing !== null && existing !== 1;

  const kept: Segment[] = [];
  for (const segment of walk.segments) {
    const category = categoryOf(segment.kind);
    if (category && wants(settings, category)) {
      removed.push({
        where: segment.where,
        kind: segment.kind,
        bytes: segment.end - segment.start,
      });
      continue;
    }
    kept.push(segment);
  }

  const bytesFor = (segment: Segment) => input.subarray(segment.start, segment.end);

  let out: Uint8Array;
  let orientationPreserved: number | null = null;

  if (walk.container === 'jpeg') {
    const pieces: Uint8Array[] = [];
    let injected = false;
    for (let i = 0; i < kept.length; i++) {
      pieces.push(bytesFor(kept[i]));
      // Exif belongs at the front, after SOI and after JFIF if one is present.
      if (needsOrientation && !injected) {
        const next = kept[i + 1];
        const atFront = kept[i].where === 'SOI' && (!next || next.where !== 'APP0');
        if (atFront || kept[i].where === 'APP0') {
          pieces.push(orientationApp1(existing!));
          orientationPreserved = existing;
          injected = true;
        }
      }
    }
    if (needsOrientation && !injected) {
      warnings.push('The image had no place to keep its rotation, so it may appear rotated.');
    }
    out = concat(pieces);
  } else if (walk.container === 'png') {
    const pieces: Uint8Array[] = [];
    // The spec wants eXIf before the image data.
    const anchor = kept.findIndex((segment) => segment.where === 'IDAT');
    const fallback = kept.findIndex((segment) => segment.where === 'IEND');
    const insertAt = anchor >= 0 ? anchor : fallback;
    for (let i = 0; i < kept.length; i++) {
      if (needsOrientation && i === insertAt) {
        pieces.push(orientationExifChunk(existing!));
        orientationPreserved = existing;
      }
      pieces.push(bytesFor(kept[i]));
    }
    if (needsOrientation && insertAt < 0) {
      warnings.push('The image had no place to keep its rotation, so it may appear rotated.');
    }
    out = concat(pieces);
  } else {
    // WebP. Two things have to agree with the chunk list: the VP8X feature
    // flags, which declare what is present, and the RIFF size.
    const hasVp8x = kept.some((segment) => segment.where === 'VP8X');
    const pieces: Uint8Array[] = [];

    for (const segment of kept) {
      if (segment.where === 'VP8X') {
        const copy = new Uint8Array(bytesFor(segment));
        // The flags byte is the first byte of the chunk's data.
        const flagsAt = segment.payloadStart - segment.start;
        let flags = copy[flagsAt];
        if (settings.exif && !needsOrientation) flags &= ~VP8X_FLAGS.exif;
        if (settings.xmp) flags &= ~VP8X_FLAGS.xmp;
        if (settings.icc) flags &= ~VP8X_FLAGS.icc;
        copy[flagsAt] = flags & 0xff;
        pieces.push(copy);
        continue;
      }
      pieces.push(bytesFor(segment));
    }

    if (needsOrientation) {
      if (hasVp8x) {
        // Metadata chunks go after the image data in a WebP.
        pieces.push(orientationWebpChunk(existing!));
        orientationPreserved = existing;
      } else {
        warnings.push(
          'This WebP has no extended header, so its rotation could not be kept and it may appear rotated.',
        );
      }
    }

    out = concat(pieces);
    // RIFF counts every byte after its own size field.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(4, out.length - 8, true);
  }

  const bytesRemoved = input.length - out.length;
  return {
    ok: true,
    bytes: out,
    removed,
    bytesRemoved,
    orientationPreserved,
    warnings,
  };
}

/**
 * The pixel-bearing bytes, which a strip must leave untouched. Comparing this
 * before and after is what proves the operation was lossless, so the tests use
 * it rather than trusting the code.
 *
 * Named explicitly per container rather than "everything structural", because
 * two structural things are ALLOWED to change: a WebP's RIFF length, and its
 * VP8X flags byte, which has to stop advertising a chunk that is now gone.
 */
const PIXEL_CHUNKS: Record<string, Set<string>> = {
  png: new Set(['signature', 'IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']),
  webp: new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']),
};

export function imageDataOf(bytes: Uint8Array): Uint8Array | null {
  const walk = walkContainer(bytes);
  if (!walk || !walk.rewritable) return null;

  const allowed = PIXEL_CHUNKS[walk.container];
  const pieces: Uint8Array[] = [];
  for (const segment of walk.segments) {
    if (segment.kind !== 'structural') continue;
    // JPEG has no chunk names to allow-list: every structural segment there is
    // a table, a frame header, or the entropy-coded scan itself.
    if (allowed && !allowed.has(segment.where)) continue;
    pieces.push(bytes.subarray(segment.start, segment.end));
  }
  return concat(pieces);
}
