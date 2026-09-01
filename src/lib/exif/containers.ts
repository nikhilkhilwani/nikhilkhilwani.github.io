/**
 * Container walking: turning a file into an ordered list of byte ranges, each
 * labelled with what it holds.
 *
 * Both the checker and the remover work from this one walk. The report reads
 * the ranges it cares about; the remover concatenates the ranges it keeps. That
 * matters more than it looks: if the two derived segment boundaries separately,
 * a fix to one would silently leave the other reading the wrong bytes, which is
 * how a "remover" ends up reporting success while leaving GPS in the file.
 *
 * Because the ranges tile the file exactly — every byte belongs to precisely
 * one segment — rebuilding is a concatenation, and the compressed image data
 * comes through byte-identical. That is the whole argument for doing this
 * surgically instead of re-encoding through a canvas.
 */

export type Container = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'tiff' | 'gif';

export type BlockKind =
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'icc'
  | 'comment'
  | 'timestamp'
  | 'text'
  | 'mpf'
  | 'vendor'
  | 'trailer'
  | 'structural';

/** The switches the interface offers. 'icc' is listed but kept by default. */
export type StripCategory = 'exif' | 'xmp' | 'iptc' | 'comments' | 'other' | 'icc';

export interface Segment {
  kind: BlockKind;
  /** What the format calls this slot: 'APP1', 'tEXt', 'EXIF'. */
  where: string;
  /** Whole segment including its framing. Ranges tile the file exactly. */
  start: number;
  end: number;
  /** The useful bytes inside the framing — after 'Exif\0\0', for instance. */
  payloadStart: number;
  payloadEnd: number;
  /** PNG text chunks and similar name their field. */
  keyword?: string;
}

export interface Walk {
  container: Container;
  segments: Segment[];
  /** Whether strip() can rebuild this container losslessly. */
  rewritable: boolean;
  warnings: string[];
}

export function categoryOf(kind: BlockKind): StripCategory | null {
  switch (kind) {
    case 'exif':
      return 'exif';
    case 'xmp':
      return 'xmp';
    case 'iptc':
      return 'iptc';
    case 'icc':
      return 'icc';
    case 'comment':
    case 'text':
    case 'timestamp':
      return 'comments';
    case 'mpf':
    case 'vendor':
    case 'trailer':
      return 'other';
    case 'structural':
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  let text = '';
  for (let i = 0; i < length && at + i < bytes.length; i++) {
    text += String.fromCharCode(bytes[at + i]);
  }
  return text;
};

const startsWith = (bytes: Uint8Array, signature: number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
};

export function detectContainer(bytes: Uint8Array): Container | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';

  // ISOBMFF: a 'ftyp' box whose brand names the flavour.
  if (bytes.length > 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    // heic, heix, hevc, heim, heis, mif1, msf1 all carry HEIF images.
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'heic';
  }

  // TIFF, which is also what a bare Exif block looks like.
  if (bytes.length > 4) {
    const mark = ascii(bytes, 0, 2);
    const magic = mark === 'MM' ? (bytes[2] << 8) | bytes[3] : (bytes[3] << 8) | bytes[2];
    if ((mark === 'MM' || mark === 'II') && magic === 42) return 'tiff';
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* JPEG                                                                       */
/* -------------------------------------------------------------------------- */

const MARKER_NAMES: Record<number, string> = {
  0xc4: 'DHT', 0xc8: 'JPG', 0xcc: 'DAC',
  0xd8: 'SOI', 0xd9: 'EOI', 0xda: 'SOS', 0xdb: 'DQT', 0xdc: 'DNL',
  0xdd: 'DRI', 0xde: 'DHP', 0xdf: 'EXP', 0xfe: 'COM',
};

const markerName = (marker: number): string => {
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker >= 0xc0 && marker <= 0xcf && !MARKER_NAMES[marker]) return `SOF${marker - 0xc0}`;
  if (marker >= 0xd0 && marker <= 0xd7) return `RST${marker - 0xd0}`;
  return MARKER_NAMES[marker] ?? `FF${marker.toString(16).toUpperCase()}`;
};

/** The NUL-terminated identifier an APPn segment opens with. */
function appIdentifier(bytes: Uint8Array, from: number, to: number): string {
  let text = '';
  for (let i = from; i < to && i < from + 40; i++) {
    if (bytes[i] === 0) break;
    text += String.fromCharCode(bytes[i]);
  }
  return text;
}

interface Classified {
  kind: BlockKind;
  /** Where the meaningful payload starts, past any identifier. */
  payloadStart: number;
}

function classifyApp(
  marker: number,
  bytes: Uint8Array,
  dataStart: number,
  dataEnd: number,
): Classified {
  if (marker === 0xfe) return { kind: 'comment', payloadStart: dataStart };

  const id = appIdentifier(bytes, dataStart, dataEnd);
  const past = dataStart + id.length + 1;

  switch (marker) {
    case 0xe0:
      // JFIF/JFXX declare pixel density and a tiny preview slot. Structural:
      // removing them changes how the image is interpreted.
      return { kind: 'structural', payloadStart: dataStart };
    case 0xe1:
      if (id === 'Exif') return { kind: 'exif', payloadStart: dataStart + 6 };
      if (id.startsWith('http://ns.adobe.com/xap/1.0/')) return { kind: 'xmp', payloadStart: past };
      if (id.startsWith('http://ns.adobe.com/xmp/extension/')) return { kind: 'xmp', payloadStart: past };
      return { kind: 'vendor', payloadStart: dataStart };
    case 0xe2:
      if (id === 'ICC_PROFILE') return { kind: 'icc', payloadStart: past + 2 };
      // Multi-Picture Format indexes further whole images appended to the file
      // — depth maps and the stills behind a phone's motion photos.
      if (id === 'MPF') return { kind: 'mpf', payloadStart: past };
      return { kind: 'vendor', payloadStart: dataStart };
    case 0xed:
      if (id.startsWith('Photoshop')) return { kind: 'iptc', payloadStart: past };
      return { kind: 'vendor', payloadStart: dataStart };
    case 0xee:
      // The Adobe APP14 marker declares the colour transform. Dropping it makes
      // CMYK and YCCK JPEGs render inverted, so it stays.
      if (id === 'Adobe') return { kind: 'structural', payloadStart: dataStart };
      return { kind: 'vendor', payloadStart: dataStart };
    default:
      return { kind: 'vendor', payloadStart: dataStart };
  }
}

/**
 * Finds where entropy-coded data ends: the next 0xFF that begins a real marker.
 * Inside a scan, 0xFF is stuffed as FF00, restart markers are in-band, and
 * runs of 0xFF are padding — none of those end it.
 */
function endOfScan(bytes: Uint8Array, from: number): number {
  let i = from;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const next = bytes[i + 1];
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
      i += 2;
      continue;
    }
    return i;
  }
  return bytes.length;
}

function walkJpeg(bytes: Uint8Array): Walk {
  const segments: Segment[] = [];
  const warnings: string[] = [];
  const push = (
    kind: BlockKind,
    where: string,
    start: number,
    end: number,
    payloadStart = start,
    payloadEnd = end,
  ) => segments.push({ kind, where, start, end, payloadStart, payloadEnd });

  push('structural', 'SOI', 0, 2);
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Bytes where a marker was expected. Keep them so a rebuild stays exact,
      // but say so — this file is not well-formed.
      let next = i;
      while (next < bytes.length && bytes[next] !== 0xff) next++;
      warnings.push('Unexpected bytes between segments; the file may be damaged.');
      push('structural', 'unknown', i, next);
      i = next;
      continue;
    }

    // Runs of 0xFF are legal padding before a marker.
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m++;
    if (m >= bytes.length) {
      // Trailing 0xFF with no marker after it: the file was never terminated by
      // an EOI, so this is truncation, not appended data. Preserve it — a strip
      // that leaves the output less valid than the input is a bug, and dropping
      // these two bytes from a stub file makes it stop being a JPEG at all.
      push('structural', 'padding', i, bytes.length);
      break;
    }

    const marker = bytes[m];
    const name = markerName(marker);

    if (marker === 0xd9) {
      push('structural', 'EOI', i, m + 1);
      i = m + 1;
      if (i < bytes.length) {
        // Anything past EOI is appended data. Phones put whole secondary images
        // here, indexed by the MPF block, so it is metadata by any measure.
        push('trailer', 'after EOI', i, bytes.length);
      }
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      push('structural', name, i, m + 1);
      i = m + 1;
      continue;
    }

    if (m + 3 > bytes.length) {
      warnings.push('A segment header ran past the end of the file.');
      // Kept, not dropped: these bytes failed to parse, so discarding them
      // would damage the file further rather than clean it.
      push('structural', 'truncated', i, bytes.length);
      break;
    }

    const length = (bytes[m + 1] << 8) | bytes[m + 2];
    // The length counts itself, so anything under two is nonsense.
    if (length < 2) {
      warnings.push(`A ${name} segment declared an impossible length.`);
      push('structural', 'malformed', i, bytes.length);
      break;
    }

    const end = m + 1 + length;
    if (end > bytes.length) {
      warnings.push(`A ${name} segment claimed more bytes than the file holds.`);
      push('structural', name, i, bytes.length);
      break;
    }

    const dataStart = m + 3;
    if (marker >= 0xe0 && marker <= 0xef) {
      const { kind, payloadStart } = classifyApp(marker, bytes, dataStart, end);
      push(kind, name, i, end, Math.min(payloadStart, end), end);
    } else if (marker === 0xfe) {
      push('comment', name, i, end, dataStart, end);
    } else {
      push('structural', name, i, end, dataStart, end);
    }

    i = end;

    if (marker === 0xda) {
      // Entropy-coded data follows the scan header, unframed.
      const scanEnd = endOfScan(bytes, i);
      if (scanEnd > i) push('structural', 'scan', i, scanEnd);
      i = scanEnd;
    }
  }

  return { container: 'jpeg', segments, rewritable: true, warnings };
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const PNG_METADATA: Record<string, BlockKind> = {
  tEXt: 'text',
  zTXt: 'text',
  iTXt: 'text',
  eXIf: 'exif',
  tIME: 'timestamp',
  iCCP: 'icc',
};

/** Reads a PNG text chunk's keyword, which precedes the value as plain bytes. */
function pngKeyword(bytes: Uint8Array, from: number, to: number): string {
  let text = '';
  for (let i = from; i < to && i < from + 80; i++) {
    if (bytes[i] === 0) break;
    text += String.fromCharCode(bytes[i]);
  }
  return text;
}

function walkPng(bytes: Uint8Array): Walk {
  const segments: Segment[] = [];
  const warnings: string[] = [];

  segments.push({
    kind: 'structural', where: 'signature',
    start: 0, end: 8, payloadStart: 0, payloadEnd: 8,
  });

  let i = 8;
  while (i + 8 <= bytes.length) {
    const length =
      ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const type = ascii(bytes, i + 4, 4);
    const end = i + 12 + length;

    if (length > 0x7fffffff || end > bytes.length) {
      warnings.push(`The ${type || 'unnamed'} chunk claimed more bytes than the file holds.`);
      segments.push({
        kind: 'trailer', where: 'truncated',
        start: i, end: bytes.length, payloadStart: i, payloadEnd: bytes.length,
      });
      return { container: 'png', segments, rewritable: false, warnings };
    }

    const dataStart = i + 8;
    const dataEnd = dataStart + length;
    let kind = PNG_METADATA[type] ?? 'structural';
    let keyword: string | undefined;

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      keyword = pngKeyword(bytes, dataStart, dataEnd);
      // XMP travels in an iTXt under a fixed keyword.
      if (keyword === 'XML:com.adobe.xmp') kind = 'xmp';
    }

    segments.push({
      kind, where: type,
      start: i, end, payloadStart: dataStart, payloadEnd: dataEnd,
      ...(keyword === undefined ? {} : { keyword }),
    });

    i = end;
    if (type === 'IEND') break;
  }

  if (i < bytes.length) {
    segments.push({
      kind: 'trailer', where: 'after IEND',
      start: i, end: bytes.length, payloadStart: i, payloadEnd: bytes.length,
    });
  }

  return { container: 'png', segments, rewritable: true, warnings };
}

/* -------------------------------------------------------------------------- */
/* WebP                                                                       */
/* -------------------------------------------------------------------------- */

const WEBP_METADATA: Record<string, BlockKind> = {
  EXIF: 'exif',
  'XMP ': 'xmp',
  ICCP: 'icc',
};

/**
 * VP8X feature flags. A chunk's presence is declared twice — once by the chunk
 * and once by a bit here — so removing a chunk without clearing its bit leaves
 * the file self-contradictory, and strict decoders reject it.
 */
export const VP8X_FLAGS = {
  icc: 0x20,
  alpha: 0x10,
  exif: 0x08,
  xmp: 0x04,
  animation: 0x02,
} as const;

function walkWebp(bytes: Uint8Array): Walk {
  const segments: Segment[] = [];
  const warnings: string[] = [];

  const declared = ((bytes[7] << 24) | (bytes[6] << 16) | (bytes[5] << 8) | bytes[4]) >>> 0;
  // The RIFF size counts everything after the size field itself.
  if (declared + 8 !== bytes.length) {
    warnings.push('The container size disagrees with the file length.');
  }

  segments.push({
    kind: 'structural', where: 'RIFF',
    start: 0, end: 12, payloadStart: 0, payloadEnd: 12,
  });

  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = ascii(bytes, i, 4);
    const size = ((bytes[i + 7] << 24) | (bytes[i + 6] << 16) | (bytes[i + 5] << 8) | bytes[i + 4]) >>> 0;
    // Odd-sized chunks are followed by a pad byte that belongs to neither.
    const padded = size + (size % 2);
    const end = i + 8 + padded;

    if (size > 0x7fffffff || i + 8 + size > bytes.length) {
      warnings.push(`The ${fourcc || 'unnamed'} chunk claimed more bytes than the file holds.`);
      segments.push({
        kind: 'trailer', where: 'truncated',
        start: i, end: bytes.length, payloadStart: i, payloadEnd: bytes.length,
      });
      return { container: 'webp', segments, rewritable: false, warnings };
    }

    segments.push({
      kind: WEBP_METADATA[fourcc] ?? 'structural',
      where: fourcc,
      start: i,
      end: Math.min(end, bytes.length),
      payloadStart: i + 8,
      payloadEnd: i + 8 + size,
    });

    i = end;
  }

  return { container: 'webp', segments, rewritable: true, warnings };
}

/* -------------------------------------------------------------------------- */

/**
 * Walks a file into segments. Returns null when the format is unrecognised, and
 * a walk with `rewritable: false` when the format is understood well enough to
 * name but not to rebuild.
 */
export function walkContainer(bytes: Uint8Array): Walk | null {
  const container = detectContainer(bytes);
  if (!container) return null;

  switch (container) {
    case 'jpeg':
      return walkJpeg(bytes);
    case 'png':
      return walkPng(bytes);
    case 'webp':
      return walkWebp(bytes);
    default:
      // Understood enough to identify and refuse. HEIC and AVIF keep metadata
      // as items in a box tree whose offsets are absolute, so removing one
      // means rewriting the tree and every offset in it; TIFF is metadata all
      // the way down. Claiming success here would be worse than declining.
      return {
        container,
        segments: [],
        rewritable: false,
        warnings: [],
      };
  }
}

/* -------------------------------------------------------------------------- */
/* CRC32, for the one place a rebuild has to write a checksum                 */
/* -------------------------------------------------------------------------- */

let crcTable: Int32Array | null = null;

function crc32Table(): Int32Array {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

/** CRC32 as PNG uses it: over the chunk type and data, not the length. */
export function crc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
