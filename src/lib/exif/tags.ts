/**
 * TIFF/IFD reading and the curated tag table behind the metadata report.
 *
 * EXIF is a TIFF file wearing a hat. A TIFF header names a byte order and
 * points at IFD0; each IFD is a count followed by 12-byte entries and a link to
 * the next one. Two entries in IFD0 are pointers to further IFDs (Exif and
 * GPS), and the IFD after IFD0 — IFD1 — describes an embedded thumbnail.
 *
 * Three things make this hostile to parse, and all three are handled here:
 *
 *   - Every offset is relative to the START OF THE TIFF HEADER, not the file.
 *     A JPEG's Exif block sits six bytes into an APP1 segment, so the base has
 *     to be threaded through rather than assumed.
 *   - An entry's value lives inline when it fits in four bytes and at an offset
 *     when it does not, so the same field is read two different ways depending
 *     on its length.
 *   - The IFD chain is a linked list of file offsets, which a malformed or
 *     hostile file can point in a circle. Reading one must terminate.
 *
 * The tag table is deliberately NOT exhaustive. This exists to answer "what
 * does this file give away", so it covers the tags that identify a person, a
 * place, a device or a moment, plus the handful of benign technical ones worth
 * showing. Anything unrecognised is still counted and still removed — it just
 * is not given a friendly name.
 */

export type MetadataGroup = 'location' | 'device' | 'time' | 'authorship' | 'software' | 'technical';

/** Which IFD an entry came from. Tag numbers collide between them. */
export type IfdKind = 'ifd0' | 'exif' | 'gps' | 'interop' | 'ifd1';

export interface TagInfo {
  label: string;
  group: MetadataGroup;
  /** Whether this field, on its own, discloses something about the person,
   *  place or device rather than the photograph. Drives the UI's emphasis. */
  sensitive: boolean;
}

export type TiffValue =
  | { kind: 'ascii'; text: string }
  | { kind: 'ints'; ints: number[] }
  | { kind: 'rationals'; pairs: [number, number][] }
  | { kind: 'bytes'; bytes: Uint8Array };

export interface TiffEntry {
  ifd: IfdKind;
  tag: number;
  type: number;
  count: number;
  value: TiffValue | null;
}

export interface ThumbnailRef {
  /** Offset from the start of the TIFF header, not the file. */
  offset: number;
  length: number;
}

export interface TiffRead {
  bigEndian: boolean;
  entries: TiffEntry[];
  thumbnail: ThumbnailRef | null;
  /** Problems that did not stop the read, for the report's caveats. */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Tag tables                                                                 */
/* -------------------------------------------------------------------------- */

const IFD0_TAGS: Record<number, TagInfo> = {
  // Standard TIFF structure tags. They also appear in IFD1, describing the
  // embedded thumbnail; unnamed they would surface as unknown-and-therefore-
  // suspect fields, which is noise rather than a finding.
  0x0100: { label: 'Image width', group: 'technical', sensitive: false },
  0x0101: { label: 'Image height', group: 'technical', sensitive: false },
  0x0102: { label: 'Bits per sample', group: 'technical', sensitive: false },
  0x0103: { label: 'Compression', group: 'technical', sensitive: false },
  0x0106: { label: 'Colour interpretation', group: 'technical', sensitive: false },
  0x0111: { label: 'Strip offsets', group: 'technical', sensitive: false },
  0x0115: { label: 'Samples per pixel', group: 'technical', sensitive: false },
  0x0116: { label: 'Rows per strip', group: 'technical', sensitive: false },
  0x0117: { label: 'Strip byte counts', group: 'technical', sensitive: false },
  0x011c: { label: 'Planar configuration', group: 'technical', sensitive: false },
  0x010e: { label: 'Image description', group: 'authorship', sensitive: true },
  0x010f: { label: 'Camera make', group: 'device', sensitive: true },
  0x0110: { label: 'Camera model', group: 'device', sensitive: true },
  0x0112: { label: 'Orientation', group: 'technical', sensitive: false },
  0x011a: { label: 'X resolution', group: 'technical', sensitive: false },
  0x011b: { label: 'Y resolution', group: 'technical', sensitive: false },
  0x0128: { label: 'Resolution unit', group: 'technical', sensitive: false },
  0x0131: { label: 'Software', group: 'software', sensitive: true },
  0x0132: { label: 'File changed', group: 'time', sensitive: true },
  0x013b: { label: 'Artist', group: 'authorship', sensitive: true },
  0x0213: { label: 'YCbCr positioning', group: 'technical', sensitive: false },
  0x8298: { label: 'Copyright', group: 'authorship', sensitive: false },
  // Windows writes these as UTF-16LE inside a BYTE array.
  0x9c9b: { label: 'Title (Windows)', group: 'authorship', sensitive: true },
  0x9c9c: { label: 'Comment (Windows)', group: 'authorship', sensitive: true },
  0x9c9d: { label: 'Author (Windows)', group: 'authorship', sensitive: true },
  0x9c9e: { label: 'Keywords (Windows)', group: 'authorship', sensitive: true },
  0x9c9f: { label: 'Subject (Windows)', group: 'authorship', sensitive: true },
};

const EXIF_TAGS: Record<number, TagInfo> = {
  0x829a: { label: 'Exposure time', group: 'technical', sensitive: false },
  0x829d: { label: 'F number', group: 'technical', sensitive: false },
  0x8822: { label: 'Exposure program', group: 'technical', sensitive: false },
  0x8827: { label: 'ISO', group: 'technical', sensitive: false },
  0x9000: { label: 'Exif version', group: 'technical', sensitive: false },
  0x9003: { label: 'Taken', group: 'time', sensitive: true },
  0x9004: { label: 'Digitised', group: 'time', sensitive: true },
  0x9010: { label: 'Time zone', group: 'time', sensitive: true },
  0x9011: { label: 'Time zone (taken)', group: 'time', sensitive: true },
  0x9012: { label: 'Time zone (digitised)', group: 'time', sensitive: true },
  0x9201: { label: 'Shutter speed', group: 'technical', sensitive: false },
  0x9202: { label: 'Aperture', group: 'technical', sensitive: false },
  0x9204: { label: 'Exposure compensation', group: 'technical', sensitive: false },
  0x9207: { label: 'Metering mode', group: 'technical', sensitive: false },
  0x9209: { label: 'Flash', group: 'technical', sensitive: false },
  0x920a: { label: 'Focal length', group: 'technical', sensitive: false },
  0x9286: { label: 'User comment', group: 'authorship', sensitive: true },
  // Proprietary and often large. Canon and Nikon have both been found to carry
  // serial numbers and face-detection data in here.
  0x927c: { label: 'Maker note', group: 'device', sensitive: true },
  0xa002: { label: 'Pixel width', group: 'technical', sensitive: false },
  0xa003: { label: 'Pixel height', group: 'technical', sensitive: false },
  0xa405: { label: 'Focal length (35mm)', group: 'technical', sensitive: false },
  0xa420: { label: 'Image unique ID', group: 'device', sensitive: true },
  0xa430: { label: 'Camera owner', group: 'authorship', sensitive: true },
  0xa431: { label: 'Body serial number', group: 'device', sensitive: true },
  0xa432: { label: 'Lens specification', group: 'technical', sensitive: false },
  0xa433: { label: 'Lens make', group: 'device', sensitive: true },
  0xa434: { label: 'Lens model', group: 'device', sensitive: true },
  0xa435: { label: 'Lens serial number', group: 'device', sensitive: true },
};

const GPS_TAGS: Record<number, TagInfo> = {
  0x0000: { label: 'GPS version', group: 'technical', sensitive: false },
  0x0001: { label: 'Latitude ref', group: 'location', sensitive: true },
  0x0002: { label: 'Latitude', group: 'location', sensitive: true },
  0x0003: { label: 'Longitude ref', group: 'location', sensitive: true },
  0x0004: { label: 'Longitude', group: 'location', sensitive: true },
  0x0005: { label: 'Altitude ref', group: 'location', sensitive: true },
  0x0006: { label: 'Altitude', group: 'location', sensitive: true },
  0x0007: { label: 'GPS time', group: 'time', sensitive: true },
  0x0008: { label: 'Satellites', group: 'technical', sensitive: false },
  0x0010: { label: 'Direction ref', group: 'location', sensitive: true },
  0x0011: { label: 'Direction', group: 'location', sensitive: true },
  0x0012: { label: 'Map datum', group: 'technical', sensitive: false },
  0x001b: { label: 'Positioning method', group: 'location', sensitive: true },
  0x001d: { label: 'GPS date', group: 'time', sensitive: true },
};

const TABLES: Record<IfdKind, Record<number, TagInfo>> = {
  ifd0: IFD0_TAGS,
  exif: EXIF_TAGS,
  gps: GPS_TAGS,
  interop: {},
  ifd1: IFD0_TAGS,
};

export function tagInfo(ifd: IfdKind, tag: number): TagInfo | null {
  return TABLES[ifd][tag] ?? null;
}

/* Structural pointers — real entries, but they describe the file's shape rather
   than its content, so the report counts them without listing them. */
const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005, 0x0201, 0x0202]);

export const ORIENTATION_TAG = 0x0112;

export function isPointerTag(tag: number): boolean {
  return POINTER_TAGS.has(tag);
}

/* -------------------------------------------------------------------------- */
/* TIFF reading                                                               */
/* -------------------------------------------------------------------------- */

/** Byte width of each TIFF type, indexed by type code. 0 marks unknown. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** Guards against an IFD chain that points in a circle. */
const MAX_IFDS = 8;
/** Guards against a corrupt count claiming millions of entries. */
const MAX_ENTRIES_PER_IFD = 4096;

/**
 * A bounds-checked view over the file, with every offset measured from the TIFF
 * header rather than the file start.
 *
 * A plain factory rather than a class with parameter properties: the test
 * runner imports these modules as TypeScript directly, and Node's strip-only
 * mode cannot compile `constructor(readonly x: T)`.
 */
interface Reader {
  bigEndian: boolean;
  /** True when [offset, offset+length) lies inside the file. */
  has: (offset: number, length: number) => boolean;
  u8: (offset: number) => number;
  u16: (offset: number) => number;
  u32: (offset: number) => number;
  i32: (offset: number) => number;
  slice: (offset: number, length: number) => Uint8Array;
}

function makeReader(bytes: Uint8Array, base: number, bigEndian: boolean): Reader {
  const u16 = (offset: number): number => {
    const i = base + offset;
    return bigEndian ? (bytes[i] << 8) | bytes[i + 1] : (bytes[i + 1] << 8) | bytes[i];
  };
  const u32 = (offset: number): number => {
    const i = base + offset;
    return bigEndian
      ? ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
      : ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0;
  };
  return {
    bigEndian,
    has: (offset, length) =>
      offset >= 0 && length >= 0 && base + offset + length <= bytes.length,
    u8: (offset) => bytes[base + offset],
    u16,
    u32,
    i32: (offset) => u32(offset) | 0,
    slice: (offset, length) => bytes.subarray(base + offset, base + offset + length),
  };
}

function decodeValue(reader: Reader, type: number, count: number, at: number): TiffValue | null {
  const unit = TYPE_SIZE[type] ?? 0;
  if (!unit) return null;
  const total = unit * count;
  if (!reader.has(at, total)) return null;

  switch (type) {
    case 2: {
      // ASCII, NUL-terminated. Trailing NULs and stray control bytes are noise.
      const raw = reader.slice(at, total);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      let text = '';
      for (let i = 0; i < end; i++) text += String.fromCharCode(raw[i]);
      return { kind: 'ascii', text };
    }
    case 1:
    case 6:
    case 7:
      return { kind: 'bytes', bytes: reader.slice(at, total) };
    case 3:
      return { kind: 'ints', ints: Array.from({ length: count }, (_, i) => reader.u16(at + i * 2)) };
    case 8:
      return {
        kind: 'ints',
        ints: Array.from({ length: count }, (_, i) => {
          const v = reader.u16(at + i * 2);
          return v > 0x7fff ? v - 0x10000 : v;
        }),
      };
    case 4:
      return { kind: 'ints', ints: Array.from({ length: count }, (_, i) => reader.u32(at + i * 4)) };
    case 9:
      return { kind: 'ints', ints: Array.from({ length: count }, (_, i) => reader.i32(at + i * 4)) };
    case 5:
    case 10: {
      const pairs: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const off = at + i * 8;
        pairs.push(
          type === 5
            ? [reader.u32(off), reader.u32(off + 4)]
            : [reader.i32(off), reader.i32(off + 4)],
        );
      }
      return { kind: 'rationals', pairs };
    }
    default:
      return { kind: 'bytes', bytes: reader.slice(at, total) };
  }
}

interface PendingIfd {
  kind: IfdKind;
  offset: number;
}

/**
 * Reads a TIFF structure starting at `start`, which must be the offset of the
 * byte-order mark within `bytes`.
 */
export function readTiff(bytes: Uint8Array, start: number): TiffRead | null {
  if (start < 0 || start + 8 > bytes.length) return null;

  const mark = (bytes[start] << 8) | bytes[start + 1];
  const bigEndian = mark === 0x4d4d; // 'MM'
  if (!bigEndian && mark !== 0x4949) return null; // not 'II' either

  const reader = makeReader(bytes, start, bigEndian);
  if (reader.u16(2) !== 42) return null;

  const warnings: string[] = [];
  const entries: TiffEntry[] = [];
  let thumbnail: ThumbnailRef | null = null;

  const queue: PendingIfd[] = [{ kind: 'ifd0', offset: reader.u32(4) }];
  const seen = new Set<number>();
  let thumbOffset: number | null = null;
  let thumbLength: number | null = null;
  let ifdsRead = 0;

  while (queue.length && ifdsRead < MAX_IFDS) {
    const { kind, offset } = queue.shift()!;
    // A zero offset means the chain ended. A repeated one means two pointers
    // name the same IFD — a sub-IFD pointer aimed back at IFD0, say — which
    // would otherwise report IFD0's tags a second time under the wrong IFD,
    // inventing fields the file does not contain. (The queue itself cannot run
    // away: only IFD0 follows a chain link, so its depth is bounded.)
    if (!offset || seen.has(offset)) continue;
    seen.add(offset);
    if (!reader.has(offset, 2)) {
      warnings.push('An IFD pointer led outside the file, so some fields may be missing.');
      continue;
    }
    ifdsRead++;

    const count = reader.u16(offset);
    if (count > MAX_ENTRIES_PER_IFD || !reader.has(offset + 2, count * 12 + 4)) {
      warnings.push('An IFD claimed more entries than the file holds, so it was skipped.');
      continue;
    }

    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = reader.u16(at);
      const type = reader.u16(at + 2);
      const valueCount = reader.u32(at + 4);
      const unit = TYPE_SIZE[type] ?? 0;

      // Values of four bytes or fewer sit in the entry itself; anything longer
      // is stored elsewhere and the entry holds an offset to it.
      const inline = unit * valueCount <= 4;
      const valueAt = inline ? at + 8 : reader.u32(at + 8);
      const value = unit === 0 ? null : decodeValue(reader, type, valueCount, valueAt);

      entries.push({ ifd: kind, tag, type, count: valueCount, value });

      if (kind === 'ifd0') {
        if (tag === 0x8769) queue.push({ kind: 'exif', offset: reader.u32(at + 8) });
        if (tag === 0x8825) queue.push({ kind: 'gps', offset: reader.u32(at + 8) });
      }
      if (kind === 'exif' && tag === 0xa005) {
        queue.push({ kind: 'interop', offset: reader.u32(at + 8) });
      }
      if (kind === 'ifd1') {
        if (tag === 0x0201) thumbOffset = reader.u32(at + 8);
        if (tag === 0x0202) thumbLength = reader.u32(at + 8);
      }
    }

    // IFD1 follows IFD0 in the chain and holds the embedded thumbnail.
    if (kind === 'ifd0') {
      const next = reader.u32(offset + 2 + count * 12);
      if (next) queue.push({ kind: 'ifd1', offset: next });
    }
  }

  if (ifdsRead >= MAX_IFDS && queue.length) {
    warnings.push('The metadata nests deeper than this reader follows; the rest was ignored.');
  }

  if (thumbOffset !== null && thumbLength) {
    if (reader.has(thumbOffset, thumbLength)) {
      thumbnail = { offset: thumbOffset, length: thumbLength };
    } else {
      warnings.push('An embedded thumbnail was declared but points outside the file.');
    }
  }

  return { bigEndian, entries, thumbnail, warnings };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const ORIENTATION_TEXT: Record<number, string> = {
  1: 'Normal',
  2: 'Mirrored',
  3: 'Rotated 180°',
  4: 'Mirrored, rotated 180°',
  5: 'Mirrored, rotated 90° CCW',
  6: 'Rotated 90° CW',
  7: 'Mirrored, rotated 90° CW',
  8: 'Rotated 90° CCW',
};

/** Windows XP* tags hold UTF-16LE in a BYTE array. */
function decodeUtf16Le(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (!code) break;
    text += String.fromCharCode(code);
  }
  return text;
}

/**
 * UserComment carries an 8-byte character-code prefix before the text, so
 * reading it as plain ASCII prepends "ASCII" to every comment.
 */
function decodeUserComment(bytes: Uint8Array): string {
  if (bytes.length <= 8) return '';
  const code = String.fromCharCode(...bytes.subarray(0, 8)).replace(/\0+$/, '');
  const body = bytes.subarray(8);
  if (code === 'UNICODE') return decodeUtf16Le(body);
  let text = '';
  for (const byte of body) {
    if (!byte) break;
    text += String.fromCharCode(byte);
  }
  return text.trim();
}

function ratio([n, d]: [number, number]): number {
  return d === 0 ? 0 : n / d;
}

/** Degrees, minutes, seconds as stored by GPS tags, collapsed to degrees. */
export function dmsToDegrees(pairs: [number, number][]): number | null {
  if (pairs.length < 1) return null;
  const [deg, min, sec] = [pairs[0], pairs[1], pairs[2]];
  let value = ratio(deg);
  if (min) value += ratio(min) / 60;
  if (sec) value += ratio(sec) / 3600;
  return Number.isFinite(value) ? value : null;
}

function trimNumber(value: number, places = 4): string {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(places)));
}

/** Human-readable rendering of one entry's value. */
export function formatValue(entry: TiffEntry): string {
  const { ifd, tag, value } = entry;
  if (!value) return '—';

  // Tags whose raw form is misleading get handled before the generic path.
  if (ifd === 'ifd0' && tag >= 0x9c9b && tag <= 0x9c9f && value.kind === 'bytes') {
    return decodeUtf16Le(value.bytes);
  }
  if (ifd === 'exif' && tag === 0x9286 && value.kind === 'bytes') {
    return decodeUserComment(value.bytes);
  }
  if (ifd === 'exif' && tag === 0x927c) {
    const size = value.kind === 'bytes' ? value.bytes.length : entry.count;
    return `${size} bytes of vendor data`;
  }
  if (ifd === 'ifd0' && tag === ORIENTATION_TAG && value.kind === 'ints') {
    const code = value.ints[0];
    return ORIENTATION_TEXT[code] ?? `Unknown (${code})`;
  }
  if (ifd === 'exif' && tag === 0x829a && value.kind === 'rationals') {
    const seconds = ratio(value.pairs[0]);
    if (seconds > 0 && seconds < 1) return `1/${Math.round(1 / seconds)} s`;
    return `${trimNumber(seconds)} s`;
  }
  if (ifd === 'exif' && tag === 0x829d && value.kind === 'rationals') {
    return `f/${trimNumber(ratio(value.pairs[0]), 1)}`;
  }
  if (ifd === 'exif' && tag === 0x920a && value.kind === 'rationals') {
    return `${trimNumber(ratio(value.pairs[0]), 1)} mm`;
  }
  if (ifd === 'gps' && (tag === 0x0002 || tag === 0x0004) && value.kind === 'rationals') {
    const degrees = dmsToDegrees(value.pairs);
    return degrees === null ? '—' : `${trimNumber(degrees, 6)}°`;
  }
  if (ifd === 'gps' && tag === 0x0007 && value.kind === 'rationals') {
    const parts = value.pairs.map((pair) => String(Math.round(ratio(pair))).padStart(2, '0'));
    return parts.join(':');
  }
  if (ifd === 'gps' && tag === 0x0005 && value.kind === 'bytes') {
    return value.bytes[0] === 1 ? 'Below sea level' : 'Above sea level';
  }

  switch (value.kind) {
    case 'ascii':
      return value.text.trim() || '—';
    case 'ints':
      return value.ints.join(', ');
    case 'rationals':
      return value.pairs.map((pair) => trimNumber(ratio(pair))).join(', ');
    case 'bytes':
      return `${value.bytes.length} bytes`;
  }
}

export interface Coordinates {
  latitude: number;
  longitude: number;
  /** Degrees/minutes/seconds, the form a map or a court record uses. */
  dms: string;
}

/** Pulls a usable position out of the GPS IFD, applying the N/S/E/W signs. */
export function coordinatesFrom(entries: TiffEntry[]): Coordinates | null {
  const gps = entries.filter((entry) => entry.ifd === 'gps');
  const find = (tag: number) => gps.find((entry) => entry.tag === tag)?.value ?? null;

  const latValue = find(0x0002);
  const lonValue = find(0x0004);
  if (!latValue || latValue.kind !== 'rationals') return null;
  if (!lonValue || lonValue.kind !== 'rationals') return null;

  const lat = dmsToDegrees(latValue.pairs);
  const lon = dmsToDegrees(lonValue.pairs);
  if (lat === null || lon === null) return null;

  const latRef = find(0x0001);
  const lonRef = find(0x0003);
  const south = latRef?.kind === 'ascii' && latRef.text.toUpperCase().startsWith('S');
  const west = lonRef?.kind === 'ascii' && lonRef.text.toUpperCase().startsWith('W');

  const latitude = south ? -lat : lat;
  const longitude = west ? -lon : lon;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const dms = (value: number, positive: string, negative: string) => {
    const sign = value < 0 ? negative : positive;
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    const minutesFull = (abs - degrees) * 60;
    const minutes = Math.floor(minutesFull);
    const seconds = (minutesFull - minutes) * 60;
    return `${degrees}°${minutes}'${seconds.toFixed(1)}"${sign}`;
  };

  return {
    latitude,
    longitude,
    dms: `${dms(latitude, 'N', 'S')} ${dms(longitude, 'E', 'W')}`,
  };
}

/** The orientation code, or null when the file does not state one. */
export function orientationFrom(entries: TiffEntry[]): number | null {
  const entry = entries.find((item) => item.ifd === 'ifd0' && item.tag === ORIENTATION_TAG);
  if (!entry || entry.value?.kind !== 'ints') return null;
  const code = entry.value.ints[0];
  return code >= 1 && code <= 8 ? code : null;
}
