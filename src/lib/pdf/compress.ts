/**
 * PDF compression, two ways.
 *
 * RECOMPRESS (default) walks the document's image XObjects and re-encodes the
 * ones it understands, leaving everything else — text, vectors, fonts — exactly
 * as it was. Verified: pdf.js extracts byte-identical text before and after.
 *
 * FLATTEN rasterises each page and rebuilds the document from those images.
 * It compresses far harder on scans, and destroys selectable text. It is never
 * the default and the UI says what it costs.
 *
 * The image encoder is injected rather than imported so the same logic runs
 * under canvas in the browser and under sharp in scripts/test-pdf.mjs. That is
 * what lets CI verify the promise that text survives.
 */

import { loadPdfLib } from './pdflib.ts';

/** Why an image was left alone. Surfaced to the visitor, so keep it plain. */
export type SkipReason =
  | 'not a JPEG'
  | 'transparency'
  | 'unsupported colour'
  | 'already small'
  | 'no gain'
  | 'encoder failed';

export interface ImageInfo {
  filters: string[];
  colorSpace: string | undefined;
  hasSMask: boolean;
  bytes: number;
}

/**
 * Decides whether an image can be safely re-encoded.
 *
 * Deliberately conservative. Re-encoding through a raster encoder always
 * produces RGB, so anything whose colour space we cannot honestly restate —
 * CMYK, Indexed, Separation — is left untouched rather than silently
 * colour-shifted. Alpha is skipped for the same reason: JPEG has none, and
 * flattening it would turn transparent areas black.
 */
export function classifyImage(info: ImageInfo, minBytes = 4096): SkipReason | 'recompress' {
  if (info.hasSMask) return 'transparency';
  if (!info.filters.includes('/DCTDecode')) return 'not a JPEG';
  if (info.bytes < minBytes) return 'already small';

  const cs = info.colorSpace ?? '';
  // A raster round trip yields RGB; only these two can be truthfully relabelled.
  if (cs !== '/DeviceRGB' && cs !== '/DeviceGray') return 'unsupported colour';

  return 'recompress';
}

export interface Encoded {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Re-encodes one JPEG. Returns null when it cannot. */
export type ImageEncoder = (
  input: Uint8Array,
  opts: { quality: number; maxEdge: number | null },
) => Promise<Encoded | null>;

export interface CompressReport {
  before: number;
  after: number;
  /** Images re-encoded. */
  touched: number;
  /** Reason -> count, for an honest summary of what was left alone. */
  skipped: Partial<Record<SkipReason, number>>;
  /** True for recompression; false when pages were flattened. */
  textPreserved: boolean;
}

export interface RecompressOptions {
  quality: number;
  /** Longest edge in pixels, or null to keep the original resolution. */
  maxEdge: number | null;
  encode: ImageEncoder;
  /** Optional password, for a protected source. */
  password?: string;
}

interface Candidate {
  ref: unknown;
  stream: { dict: { get: (k: unknown) => unknown; set: (k: unknown, v: unknown) => void }; contents: Uint8Array };
  info: ImageInfo;
  verdict: SkipReason | 'recompress';
}

/**
 * Finds every image XObject and classifies it.
 *
 * Shared by the real run and the size estimate on purpose: an estimate derived
 * from different rules than the conversion would drift from it, and a number
 * that quietly disagrees with the result is worse than no number at all.
 */
async function collectImages(doc: {
  context: { enumerateIndirectObjects: () => Iterable<[unknown, unknown]> };
}): Promise<Candidate[]> {
  const { PDFName, PDFRawStream, PDFArray } = await loadPdfLib();
  const out: Candidate[] = [];

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;

    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;

    const filter = dict.get(PDFName.of('Filter'));
    const filters =
      filter instanceof PDFArray
        ? filter.asArray().map((f) => f.toString())
        : [filter?.toString()].filter((f): f is string => !!f);

    const info: ImageInfo = {
      filters,
      colorSpace: dict.get(PDFName.of('ColorSpace'))?.toString(),
      hasSMask: !!dict.get(PDFName.of('SMask')),
      bytes: obj.contents.length,
    };

    out.push({ ref, stream: obj as unknown as Candidate['stream'], info, verdict: classifyImage(info) });
  }
  return out;
}

const tally = (skipped: Partial<Record<SkipReason, number>>, reason: SkipReason) => {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
};

/**
 * Re-encodes every eligible image in place.
 *
 * Text, vectors and fonts are untouched: only image stream contents change,
 * plus the three dictionary entries that describe them.
 */
export async function recompressImages(
  input: Uint8Array,
  { quality, maxEdge, encode, password }: RecompressOptions,
): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const { PDFDocument, PDFName, PDFRawStream } = await loadPdfLib();

  const doc = await PDFDocument.load(input, password ? { password } : undefined);
  const skipped: Partial<Record<SkipReason, number>> = {};
  let touched = 0;

  for (const candidate of await collectImages(doc)) {
    if (candidate.verdict !== 'recompress') {
      tally(skipped, candidate.verdict);
      continue;
    }

    let encoded: Encoded | null;
    try {
      encoded = await encode(candidate.stream.contents, { quality, maxEdge });
    } catch {
      encoded = null;
    }
    if (!encoded) {
      tally(skipped, 'encoder failed');
      continue;
    }
    // Never make a file bigger in the name of compression.
    if (encoded.bytes.length >= candidate.info.bytes) {
      tally(skipped, 'no gain');
      continue;
    }

    const dict = candidate.stream.dict;
    dict.set(PDFName.of('Length'), doc.context.obj(encoded.bytes.length));
    dict.set(PDFName.of('Width'), doc.context.obj(encoded.width));
    dict.set(PDFName.of('Height'), doc.context.obj(encoded.height));
    // The round trip produced RGB, so say so — a stale /DeviceGray here would
    // make readers misinterpret three channels as one.
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    dict.set(PDFName.of('BitsPerComponent'), doc.context.obj(8));
    doc.context.assign(candidate.ref as never, PDFRawStream.of(dict as never, encoded.bytes));
    touched++;
  }

  const bytes = await doc.save();
  return {
    bytes,
    report: { before: input.length, after: bytes.length, touched, skipped, textPreserved: true },
  };
}

/* ---------------------------------------------------------------- estimate */

export interface Estimate {
  before: number;
  /** Predicted size of the compressed file. */
  after: number;
  touched: number;
  skipped: Partial<Record<SkipReason, number>>;
  /** True when only the largest images were encoded and the rest extrapolated. */
  sampled: boolean;
}

/**
 * How many images to actually encode before extrapolating. Encoding is the
 * expensive part, and this runs on every drag of the quality slider.
 */
export const SAMPLE_LIMIT = 6;

/**
 * Predicts the compressed size without building the PDF.
 *
 * Everything that is not an image byte is untouched by this mode, so the
 * arithmetic is simply: original size, minus the images we will replace, plus
 * what they become. The only error is the small amount of xref the save
 * rewrites.
 */
export async function estimateRecompress(
  input: Uint8Array,
  { quality, maxEdge, encode, password }: RecompressOptions,
): Promise<Estimate> {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(input, password ? { password } : undefined);

  const candidates = await collectImages(doc);
  const skipped: Partial<Record<SkipReason, number>> = {};
  const eligible: Candidate[] = [];

  for (const candidate of candidates) {
    if (candidate.verdict === 'recompress') eligible.push(candidate);
    else tally(skipped, candidate.verdict);
  }

  // Largest first, so a sample covers the bytes that actually matter.
  eligible.sort((a, b) => b.info.bytes - a.info.bytes);
  const sampled = eligible.length > SAMPLE_LIMIT;
  const toEncode = sampled ? eligible.slice(0, SAMPLE_LIMIT) : eligible;

  let sampledBefore = 0;
  let sampledAfter = 0;
  let touched = 0;

  for (const candidate of toEncode) {
    let encoded: Encoded | null;
    try {
      encoded = await encode(candidate.stream.contents, { quality, maxEdge });
    } catch {
      encoded = null;
    }
    if (!encoded) {
      tally(skipped, 'encoder failed');
      continue;
    }
    if (encoded.bytes.length >= candidate.info.bytes) {
      tally(skipped, 'no gain');
      continue;
    }
    sampledBefore += candidate.info.bytes;
    sampledAfter += encoded.bytes.length;
    touched++;
  }

  // Extrapolate the remainder at the ratio the sample achieved.
  const ratio = sampledBefore > 0 ? sampledAfter / sampledBefore : 1;
  const restBefore = sampled
    ? eligible.slice(SAMPLE_LIMIT).reduce((sum, c) => sum + c.info.bytes, 0)
    : 0;
  const restAfter = Math.round(restBefore * ratio);
  if (sampled) touched += eligible.length - SAMPLE_LIMIT;

  const saved = sampledBefore - sampledAfter + (restBefore - restAfter);
  return {
    before: input.length,
    after: Math.max(1024, input.length - saved),
    touched,
    skipped,
    sampled,
  };
}

/**
 * Predicts the flattened size by rendering one page and scaling by the count.
 *
 * Rendering every page to preview a number would cost as much as doing the
 * conversion, so this is explicitly an estimate and the UI labels it as one.
 */
export async function estimateFlatten(
  originalSize: number,
  { renderPage, pages }: Pick<FlattenOptions, 'renderPage' | 'pages'>,
): Promise<Estimate> {
  if (!pages.length) {
    return { before: originalSize, after: originalSize, touched: 0, skipped: {}, sampled: false };
  }
  const first = await renderPage(pages[0].number);
  // Roughly 1.5 kB of PDF structure wraps each embedded page image.
  const perPage = first.bytes.length + 1536;
  return {
    before: originalSize,
    after: Math.max(1024, perPage * pages.length),
    touched: pages.length,
    skipped: {},
    sampled: pages.length > 1,
  };
}

/** "≈ 412 kB · 76% smaller", or an honest note when it would not shrink. */
export function describeEstimate(estimate: Estimate, formatBytes: (n: number) => string): string {
  const pct = percentSaved(estimate.before, estimate.after);
  const prefix = estimate.sampled ? '≈ ' : '';
  if (estimate.touched === 0) return 'Nothing here can be recompressed at this setting.';
  if (pct <= 0) return `${prefix}${formatBytes(estimate.after)} — no smaller than the original.`;
  return `${prefix}${formatBytes(estimate.after)} · about ${pct}% smaller`;
}

export interface FlattenOptions {
  /** Renders one page to an encoded JPEG. Supplied by the page (pdf.js + canvas). */
  renderPage: (pageNumber: number) => Promise<{ bytes: Uint8Array; width: number; height: number }>;
  /** Page count and each page's size in PDF points, so geometry is preserved. */
  pages: { number: number; width: number; height: number }[];
  onProgress?: (done: number, total: number) => void;
}

/**
 * Rebuilds the document from rendered page images.
 *
 * Page geometry is preserved in points, so the result prints at the original
 * size even though its contents are now pixels.
 */
export async function flattenToImages(
  originalSize: number,
  { renderPage, pages, onProgress }: FlattenOptions,
): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  doc.setProducer('nikhilkhilwani.github.io/tools/compress-pdf');

  let done = 0;
  for (const page of pages) {
    const image = await renderPage(page.number);
    const embedded = await doc.embedJpg(image.bytes);
    const sheet = doc.addPage([page.width, page.height]);
    sheet.drawImage(embedded, { x: 0, y: 0, width: page.width, height: page.height });
    onProgress?.(++done, pages.length);
  }

  const bytes = await doc.save();
  return {
    bytes,
    report: {
      before: originalSize,
      after: bytes.length,
      touched: pages.length,
      skipped: {},
      textPreserved: false,
    },
  };
}

/* ---------------------------------------------------------------- reporting */

export const percentSaved = (before: number, after: number): number =>
  before <= 0 ? 0 : Math.round(((before - after) / before) * 100);

/** One honest sentence about what happened, including what was left alone. */
export function describeReport(report: CompressReport): string {
  const pct = percentSaved(report.before, report.after);
  const size = pct > 0 ? `${pct}% smaller` : pct === 0 ? 'the same size' : `${-pct}% larger`;

  if (!report.textPreserved) {
    return `Flattened ${report.touched} page${report.touched === 1 ? '' : 's'} to images — ${size}. Text is no longer selectable.`;
  }

  const skippedTotal = Object.values(report.skipped).reduce((a, b) => a + (b ?? 0), 0);
  const parts = [
    `Recompressed ${report.touched} image${report.touched === 1 ? '' : 's'} — ${size}.`,
    'Text and vectors are untouched.',
  ];
  if (skippedTotal) {
    const detail = Object.entries(report.skipped)
      .filter(([, n]) => n)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    parts.push(`Left alone: ${detail}.`);
  }
  return parts.join(' ');
}

/** Nothing was gained and nothing was lost — worth saying rather than shipping a no-op. */
export const isNoOp = (report: CompressReport): boolean =>
  report.textPreserved && report.touched === 0;
