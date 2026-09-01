/**
 * The checker: what does this file give away?
 *
 * Built on the same container walk the remover uses, so the two can never
 * disagree about where metadata lives. The report is deliberately organised
 * around disclosure rather than around the file format — a person wants to know
 * that their address and their phone's serial number are in there, not that
 * IFD0 entry 7 is of type SHORT.
 *
 * The embedded thumbnail gets its own place in the report for a specific
 * reason: it is generated at capture and preserved by most editors, so when
 * someone crops a person out of a photo and saves it, the thumbnail can still
 * show the original frame. It is the one piece of metadata that leaks the
 * picture itself.
 */

import {
  categoryOf,
  walkContainer,
  type BlockKind,
  type Container,
  type Segment,
  type StripCategory,
} from './containers.ts';
import {
  coordinatesFrom,
  formatValue,
  isPointerTag,
  orientationFrom,
  readTiff,
  tagInfo,
  type Coordinates,
  type MetadataGroup,
} from './tags.ts';

export interface MetadataField {
  /** Where it came from, for anyone who wants to look it up. */
  source: string;
  label: string;
  value: string;
  group: MetadataGroup;
  sensitive: boolean;
}

export interface MetadataBlock {
  kind: BlockKind;
  where: string;
  bytes: number;
  category: StripCategory | null;
  keyword?: string;
}

export interface MetadataReport {
  container: Container | null;
  /** Whether the remover can rebuild this container. */
  rewritable: boolean;
  blocks: MetadataBlock[];
  fields: MetadataField[];
  coordinates: Coordinates | null;
  orientation: number | null;
  /** Bytes of an embedded preview image, if the file carries one. */
  thumbnail: Uint8Array | null;
  metadataBytes: number;
  fileBytes: number;
  warnings: string[];
}

/** Optional zlib, supplied by the caller so this module stays dependency-free. */
export type Inflate = (bytes: Uint8Array) => Uint8Array;

const EMPTY: MetadataReport = {
  container: null,
  rewritable: false,
  blocks: [],
  fields: [],
  coordinates: null,
  orientation: null,
  thumbnail: null,
  metadataBytes: 0,
  fileBytes: 0,
  warnings: [],
};

/* -------------------------------------------------------------------------- */
/* PNG text chunks                                                            */
/* -------------------------------------------------------------------------- */

/** PNG keywords worth naming. Anything else is still shown, just generically. */
const PNG_KEYWORDS: Record<string, { label: string; group: MetadataGroup; sensitive: boolean }> = {
  Software: { label: 'Software', group: 'software', sensitive: true },
  Author: { label: 'Author', group: 'authorship', sensitive: true },
  Artist: { label: 'Artist', group: 'authorship', sensitive: true },
  Comment: { label: 'Comment', group: 'authorship', sensitive: true },
  Description: { label: 'Description', group: 'authorship', sensitive: true },
  Title: { label: 'Title', group: 'authorship', sensitive: true },
  Copyright: { label: 'Copyright', group: 'authorship', sensitive: false },
  'Creation Time': { label: 'Created', group: 'time', sensitive: true },
  Source: { label: 'Source device', group: 'device', sensitive: true },
};

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
};

const utf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
};

/**
 * Decodes one PNG text chunk. The three flavours differ in whether the value is
 * Latin-1, UTF-8, or deflated, and iTXt carries two extra NUL-terminated fields
 * before its text that are easy to mistake for the value.
 */
function pngText(
  type: string,
  data: Uint8Array,
  inflate?: Inflate,
): { keyword: string; value: string } | null {
  let split = data.indexOf(0);
  if (split < 0) return null;
  const keyword = latin1(data.subarray(0, split));

  if (type === 'tEXt') {
    return { keyword, value: latin1(data.subarray(split + 1)) };
  }

  if (type === 'zTXt') {
    // keyword \0 compressionMethod compressedText
    const body = data.subarray(split + 2);
    if (!inflate) return { keyword, value: `(compressed, ${body.length} bytes)` };
    try {
      return { keyword, value: latin1(inflate(body)) };
    } catch {
      return { keyword, value: `(compressed, ${body.length} bytes, unreadable)` };
    }
  }

  // iTXt: keyword \0 compressionFlag compressionMethod language \0 translated \0 text
  const compressed = data[split + 1] === 1;
  let at = split + 3;
  for (let skipped = 0; skipped < 2; skipped++) {
    const next = data.indexOf(0, at);
    if (next < 0) return { keyword, value: '' };
    at = next + 1;
  }
  const body = data.subarray(at);
  if (!compressed) return { keyword, value: utf8(body) };
  if (!inflate) return { keyword, value: `(compressed, ${body.length} bytes)` };
  try {
    return { keyword, value: utf8(inflate(body)) };
  } catch {
    return { keyword, value: `(compressed, ${body.length} bytes, unreadable)` };
  }
}

/* -------------------------------------------------------------------------- */
/* XMP                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * XMP is RDF/XML and parsing it properly is its own project. These are the few
 * properties that actually identify someone; everything else in the packet is
 * still counted and still removed.
 */
const XMP_PROPERTIES: { pattern: RegExp; label: string; group: MetadataGroup; sensitive: boolean }[] = [
  { pattern: /xmp:CreatorTool>([^<]+)</, label: 'Created with', group: 'software', sensitive: true },
  { pattern: /xmp:CreatorTool="([^"]+)"/, label: 'Created with', group: 'software', sensitive: true },
  { pattern: /dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]+)</, label: 'Creator', group: 'authorship', sensitive: true },
  { pattern: /photoshop:DateCreated>([^<]+)</, label: 'Created', group: 'time', sensitive: true },
  { pattern: /photoshop:City>([^<]+)</, label: 'City', group: 'location', sensitive: true },
  { pattern: /photoshop:Country>([^<]+)</, label: 'Country', group: 'location', sensitive: true },
  { pattern: /tiff:Make>([^<]+)</, label: 'Camera make', group: 'device', sensitive: true },
  { pattern: /tiff:Model>([^<]+)</, label: 'Camera model', group: 'device', sensitive: true },
  { pattern: /exif:GPSLatitude>([^<]+)</, label: 'Latitude (XMP)', group: 'location', sensitive: true },
  { pattern: /exif:GPSLongitude>([^<]+)</, label: 'Longitude (XMP)', group: 'location', sensitive: true },
];

function xmpFields(text: string): MetadataField[] {
  const fields: MetadataField[] = [];
  const seen = new Set<string>();
  for (const property of XMP_PROPERTIES) {
    const match = property.pattern.exec(text);
    if (!match) continue;
    const value = match[1].trim();
    if (!value || seen.has(property.label)) continue;
    seen.add(property.label);
    fields.push({
      source: 'XMP',
      label: property.label,
      value,
      group: property.group,
      sensitive: property.sensitive,
    });
  }
  return fields;
}

/* -------------------------------------------------------------------------- */

/** Reads the Exif block a segment points at, adding its fields to the report. */
function exifFields(
  bytes: Uint8Array,
  segment: Segment,
  report: MetadataReport,
): void {
  const tiff = readTiff(bytes, segment.payloadStart);
  if (!tiff) {
    report.warnings.push('An Exif block was present but could not be read.');
    return;
  }
  report.warnings.push(...tiff.warnings);

  const ifdLabel: Record<string, string> = {
    ifd0: 'Exif',
    exif: 'Exif',
    gps: 'GPS',
    interop: 'Exif',
    ifd1: 'Thumbnail',
  };

  for (const entry of tiff.entries) {
    if (isPointerTag(entry.tag)) continue;
    const info = tagInfo(entry.ifd, entry.tag);
    const value = formatValue(entry);
    if (value === '—' || value === '') continue;

    report.fields.push({
      source: ifdLabel[entry.ifd] ?? 'Exif',
      label: info?.label ?? `Tag 0x${entry.tag.toString(16).padStart(4, '0')}`,
      value,
      group: info?.group ?? 'technical',
      // An unrecognised tag holding free text is exactly where a vendor hides
      // something, so unknowns are treated as sensitive rather than ignored.
      sensitive: info?.sensitive ?? true,
    });
  }

  report.coordinates ??= coordinatesFrom(tiff.entries);
  report.orientation ??= orientationFrom(tiff.entries);

  if (tiff.thumbnail && !report.thumbnail) {
    const from = segment.payloadStart + tiff.thumbnail.offset;
    const to = from + tiff.thumbnail.length;
    if (to <= bytes.length) report.thumbnail = bytes.subarray(from, to);
  }
}

/**
 * Inspects an image without decoding it. Pure, synchronous, and safe on
 * hostile input: malformed offsets are reported rather than followed.
 *
 * `inflate` is optional. Supply fflate's `unzlibSync` to read PNG's compressed
 * text chunks; without it their presence and size are still reported.
 */
export function readMetadata(bytes: Uint8Array, inflate?: Inflate): MetadataReport {
  if (!bytes.length) return { ...EMPTY };

  const walk = walkContainer(bytes);
  if (!walk) return { ...EMPTY, fileBytes: bytes.length };

  const report: MetadataReport = {
    container: walk.container,
    rewritable: walk.rewritable,
    blocks: [],
    fields: [],
    coordinates: null,
    orientation: null,
    thumbnail: null,
    metadataBytes: 0,
    fileBytes: bytes.length,
    warnings: [...walk.warnings],
  };

  for (const segment of walk.segments) {
    const category = categoryOf(segment.kind);
    if (!category) continue;

    const size = segment.end - segment.start;
    report.metadataBytes += size;
    report.blocks.push({
      kind: segment.kind,
      where: segment.where,
      bytes: size,
      category,
      ...(segment.keyword === undefined ? {} : { keyword: segment.keyword }),
    });

    const payload = bytes.subarray(segment.payloadStart, segment.payloadEnd);

    if (segment.kind === 'exif') {
      exifFields(bytes, segment, report);
      continue;
    }

    if (segment.kind === 'xmp') {
      report.fields.push(...xmpFields(utf8(payload)));
      continue;
    }

    if (segment.kind === 'text' || segment.kind === 'comment') {
      if (walk.container === 'png') {
        const decoded = pngText(segment.where, payload, inflate);
        if (decoded && decoded.value.trim()) {
          const known = PNG_KEYWORDS[decoded.keyword];
          report.fields.push({
            source: segment.where,
            label: known?.label ?? (decoded.keyword || 'Text'),
            value: decoded.value.trim().slice(0, 2000),
            group: known?.group ?? 'authorship',
            sensitive: known?.sensitive ?? true,
          });
        }
        continue;
      }
      // A JPEG comment is free text with no structure at all.
      const text = latin1(payload).replace(/\0+$/, '').trim();
      if (text) {
        report.fields.push({
          source: segment.where,
          label: 'Comment',
          value: text.slice(0, 2000),
          group: 'authorship',
          sensitive: true,
        });
      }
      continue;
    }

    if (segment.kind === 'iptc') {
      // IPTC's IIM records are a separate format again. Reporting the block
      // without pretending to read it is more honest than a partial parse;
      // it is removed either way.
      report.fields.push({
        source: 'IPTC',
        label: 'IPTC record',
        value: `${size} bytes — may name a photographer, caption, city or country`,
        group: 'authorship',
        sensitive: true,
      });
      continue;
    }

    if (segment.kind === 'mpf') {
      report.fields.push({
        source: 'MPF',
        label: 'Extra images',
        value: 'This file indexes further whole images appended after the visible one',
        group: 'technical',
        sensitive: true,
      });
      continue;
    }

    if (segment.kind === 'timestamp') {
      report.fields.push({
        source: segment.where,
        label: 'Last modified',
        value: readPngTime(payload),
        group: 'time',
        sensitive: true,
      });
    }
  }

  if (!walk.rewritable && walk.segments.length === 0) {
    report.warnings.push(
      `${walk.container.toUpperCase()} files are recognised but not yet inspected in detail.`,
    );
  }

  return report;
}

/** PNG's tIME chunk: a seven-byte UTC timestamp. */
function readPngTime(data: Uint8Array): string {
  if (data.length < 7) return `${data.length} bytes`;
  const year = (data[0] << 8) | data[1];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(data[2])}-${pad(data[3])} ${pad(data[4])}:${pad(data[5])}:${pad(data[6])} UTC`;
}

/* -------------------------------------------------------------------------- */
/* Summaries for the interface                                                */
/* -------------------------------------------------------------------------- */

export interface ReportSummary {
  /** Fields that disclose a person, place, device or moment. */
  sensitive: number;
  total: number;
  hasLocation: boolean;
  hasThumbnail: boolean;
  groups: MetadataGroup[];
}

export function summarise(report: MetadataReport): ReportSummary {
  const groups = new Set<MetadataGroup>();
  let sensitive = 0;
  for (const field of report.fields) {
    groups.add(field.group);
    if (field.sensitive) sensitive++;
  }
  return {
    sensitive,
    total: report.fields.length,
    hasLocation: report.coordinates !== null,
    hasThumbnail: report.thumbnail !== null,
    groups: [...groups],
  };
}

/** One line stating what the file gives away, for the top of the report. */
export function describeReport(report: MetadataReport): string {
  if (!report.container) return 'This file is not an image format the tool recognises.';
  if (!report.blocks.length) return 'No metadata found. This file is already clean.';

  const summary = summarise(report);
  const parts: string[] = [];
  if (summary.hasLocation) parts.push('where it was taken');
  if (report.fields.some((field) => field.group === 'device')) parts.push('the device that took it');
  if (report.fields.some((field) => field.group === 'time')) parts.push('when');
  if (report.fields.some((field) => field.group === 'authorship')) parts.push('who to credit');
  if (summary.hasThumbnail) parts.push('an embedded preview');

  if (!parts.length) {
    return `${report.blocks.length} metadata block${report.blocks.length === 1 ? '' : 's'}, none of it identifying.`;
  }

  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `This file records ${list}.`;
}

export const READ_CAVEATS = [
  'IPTC records and vendor maker notes are detected and removed, but not read field by field',
  'HEIC, AVIF and TIFF are recognised but cannot be inspected or cleaned yet',
  'Removing metadata is not anonymity: sensor noise, lens characteristics and the compression tables still identify a camera model',
] as const;
