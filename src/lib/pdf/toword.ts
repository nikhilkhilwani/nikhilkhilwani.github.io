/**
 * PDF to Word.
 *
 * The impure half: drives pdf.js, resolves what the pure inference in
 * textitems.ts needs, and packages the result with the writer in docx/ooxml.ts.
 *
 * Two things here are worth knowing before changing anything.
 *
 * Bold and italic have to be read from the font's NAME. pdf.js reports every
 * font in `getTextContent().styles` with a generic `fontFamily` of
 * "sans-serif" and leaves `.bold`/`.italic` undefined, so the only thing
 * distinguishing Carlito-Bold from Carlito-Regular is the string
 * "Carlito-Bold-8774" hanging off the font object. Reaching it means asking for
 * the operator list — which pdf.js needs anyway to resolve the font objects at
 * all — and it is wrapped in a guard, because it is the least public thing this
 * module touches. Without it the text still converts; it just loses its weight.
 *
 * A PDF that cannot be converted honestly must say so rather than produce an
 * empty or garbled document. Three cases are detected and reported: a scan with
 * no text layer, glyphs with no Unicode mapping, and side-by-side columns.
 */

import { loadPdfjs, openPdf } from './pdfjs.ts';
import {
  furnitureFlags,
  looksMultiColumn,
  looksScanned,
  toBlocks,
  toLines,
  unmappedRatio,
  bodySize,
  type Block,
  type RawItem,
  type Span,
} from './textitems.ts';
import { buildDocx, type DocBlock } from '../docx/ooxml.ts';

export interface ConvertOptions {
  password?: string;
  /** Keep images found on the page, placed in reading order. */
  images?: boolean;
  /** Reconstruct tables from column alignment. */
  tables?: boolean;
  /** Insert an explicit page break between PDF pages. */
  pageBreaks?: boolean;
  /** Keep running headers and footers as body text instead of dropping them. */
  keepFurniture?: boolean;
  /** Called after each page so the UI can show progress. */
  onProgress?: (page: number, total: number) => void;
}

export interface PageReport {
  page: number;
  lines: number;
  blocks: number;
  scanned: boolean;
  multiColumn: boolean;
  unreadableRatio: number;
}

export interface ConvertResult {
  /** The .docx bytes. */
  bytes: Uint8Array;
  pages: PageReport[];
  /** Counts by block kind, for the summary. */
  counts: Record<string, number>;
  /** How many repeated header and footer lines were left out. */
  furnitureDropped: number;
  /** Things the visitor needs to know about this particular file. */
  warnings: string[];
  /** True when no page had a usable text layer. */
  empty: boolean;
}

/** A run of glyphs as pdf.js reports it, before we normalise it. */
interface TextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
  type?: string;
}

/**
 * Maps pdf.js's internal font ids to the real font names.
 *
 * `commonObjs` is not a documented API, so every access is guarded and a
 * failure degrades to "no weight information" rather than throwing.
 */
async function fontNames(page: {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  commonObjs?: { has: (key: string) => boolean; get: (key: string) => unknown };
  objs?: { has: (key: string) => boolean; get: (key: string) => unknown };
}, setFontOp: number): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const ops = await page.getOperatorList();
    const ids = new Set<string>();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === setFontOp) {
        const id = ops.argsArray[i]?.[0];
        if (typeof id === 'string') ids.add(id);
      }
    }
    for (const id of ids) {
      const store = page.commonObjs?.has(id) ? page.commonObjs : page.objs?.has(id) ? page.objs : null;
      const object = store?.get(id) as { name?: unknown } | undefined;
      if (object && typeof object.name === 'string') names.set(id, object.name);
    }
  } catch {
    // Leave the map empty; styleOf then sees the internal id and reports
    // neither bold nor italic, which is the right failure.
  }
  return names;
}

/** Counts image paint operations, which is how a scan is recognised. */
async function imageCount(
  page: { getOperatorList: () => Promise<{ fnArray: number[] }> },
  ops: { paintImageXObject: number; paintInlineImageXObject: number; paintImageMaskXObject: number },
): Promise<number> {
  try {
    const list = await page.getOperatorList();
    let count = 0;
    for (const fn of list.fnArray) {
      if (
        fn === ops.paintImageXObject ||
        fn === ops.paintInlineImageXObject ||
        fn === ops.paintImageMaskXObject
      ) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function normalise(items: TextItem[], names: Map<string, string>): RawItem[] {
  const out: RawItem[] = [];
  for (const item of items) {
    if (item.type === 'beginMarkedContent' || item.type === 'endMarkedContent') continue;
    const text = item.str;
    const transform = item.transform;
    if (typeof text !== 'string' || !transform || transform.length < 6) continue;

    // The text matrix carries the effective size; a declared font size means
    // nothing on its own because the matrix may scale it.
    const size = Math.hypot(transform[0], transform[1]) || item.height || 11;
    const id = item.fontName ?? '';
    out.push({
      text,
      x: transform[4],
      y: transform[5],
      width: item.width ?? 0,
      size,
      font: names.get(id) ?? id,
      eol: item.hasEOL === true,
    });
  }
  return out;
}

export class NotAPdf extends Error {
  constructor() {
    super('This does not look like a PDF.');
    this.name = 'NotAPdf';
  }
}

/** A PDF starts with "%PDF-". */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export async function pdfToWord(
  input: Uint8Array,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  if (!looksLikePdf(input)) throw new NotAPdf();

  const pdfjs = await loadPdfjs();
  const { doc } = await openPdf(input, options.password);

  const pages: PageReport[] = [];
  const blocks: DocBlock[] = [];
  const warnings: string[] = [];
  let pageWidth = 595.28;
  let pageHeight = 841.89;
  let margin = 56.7;
  let dominant = 11;
  const sizes: number[] = [];

  // Two passes are unavoidable: a running header is only recognisable once
  // every page has been read, because repetition is the only thing that
  // distinguishes it from an ordinary line of text.
  interface Scanned {
    number: number;
    lines: ReturnType<typeof toLines>;
    height: number;
    scanned: boolean;
    multiColumn: boolean;
    unreadable: number;
  }
  const scans: Scanned[] = [];

  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    if (number === 1) {
      pageWidth = viewport.width;
      pageHeight = viewport.height;
    }

    const names = await fontNames(page as never, pdfjs.OPS.setFont);
    const content = await page.getTextContent();
    const items = normalise(content.items as TextItem[], names);
    const images = await imageCount(page as never, pdfjs.OPS as never);

    const lines = toLines(items);
    if (lines.length) {
      sizes.push(bodySize(lines));
      // The left margin of the first page stands in for the document's.
      if (number === 1) margin = Math.min(...lines.map((line) => line.x));
    }

    scans.push({
      number,
      lines,
      height: viewport.height,
      scanned: looksScanned(items, images),
      multiColumn: looksMultiColumn(lines, viewport.width),
      unreadable: unmappedRatio(items),
    });

    options.onProgress?.(number, doc.numPages);
    page.cleanup();
  }

  const flags =
    options.keepFurniture === true
      ? scans.map((scan) => scan.lines.map(() => false))
      : furnitureFlags(scans.map((scan) => ({ lines: scan.lines, height: scan.height })));

  let furnitureDropped = 0;
  for (const [index, scan] of scans.entries()) {
    const keep = scan.lines.filter((_, i) => !flags[index]?.[i]);
    furnitureDropped += scan.lines.length - keep.length;

    const pageBlocks = keep.length ? toBlocks(keep) : [];
    if (options.tables === false) {
      for (const block of pageBlocks) {
        if (block.kind === 'table') flattenTable(block);
      }
    }

    if (options.pageBreaks !== false && scan.number > 1 && blocks.length) {
      blocks.push({ kind: 'pagebreak' });
    }
    blocks.push(...pageBlocks);

    pages.push({
      page: scan.number,
      lines: scan.lines.length,
      blocks: pageBlocks.length,
      scanned: scan.scanned,
      multiColumn: scan.multiColumn,
      unreadableRatio: scan.unreadable,
    });
  }

  if (sizes.length) {
    dominant = sizes.slice().sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
  }

  const scannedPages = pages.filter((entry) => entry.scanned).length;
  const withText = pages.filter((entry) => entry.lines > 0).length;

  if (scannedPages) {
    warnings.push(
      scannedPages === pages.length
        ? 'This PDF is a scan: the pages are pictures, with no text to extract. Reading it needs OCR, which this tool does not do.'
        : `${scannedPages} of ${pages.length} pages are scans with no text layer, and come through empty.`,
    );
  }
  const garbled = pages.filter((entry) => entry.unreadableRatio > 0.2).length;
  if (garbled) {
    warnings.push(
      `${garbled} page${garbled === 1 ? '' : 's'} use fonts with no readable character mapping, so some text cannot be recovered and may come through as symbols.`,
    );
  }
  const columned = pages.filter((entry) => entry.multiColumn).length;
  if (columned) {
    warnings.push(
      `${columned} page${columned === 1 ? '' : 's'} appear to be laid out in side-by-side columns. Text is read straight down the page, so those columns may be interleaved.`,
    );
  }

  const counts: Record<string, number> = {};
  for (const block of blocks) counts[block.kind] = (counts[block.kind] ?? 0) + 1;

  const { files } = buildDocx(blocks, {
    pageWidth,
    pageHeight,
    margin: Math.min(Math.max(margin, 18), 144),
    bodySize: dominant,
  });

  const { zipSync } = await import('fflate');
  // Copy out of fflate's view so the Blob does not hold onto its buffer.
  const packed = zipSync(files, { level: 6 });
  const bytes = new Uint8Array(packed);

  // cleanup() is the documented way to release a document's resources.
  doc.cleanup();

  return { bytes, pages, counts, warnings, furnitureDropped, empty: withText === 0 };
}

/** Turns a table back into plain paragraphs, one row per line. */
function flattenTable(block: Block): void {
  const rows = block.rows ?? [];
  const spans: Span[] = [];
  for (const row of rows) {
    for (const cell of row) {
      for (const span of cell) spans.push({ ...span });
      // A tab between cells, so a flattened row still reads as columns.
      const previous = spans[spans.length - 1];
      spans.push({
        text: '\t',
        bold: false,
        italic: false,
        mono: false,
        size: previous?.size ?? 11,
        x: previous ? previous.x + previous.width : 0,
        width: 0,
      });
    }
  }
  block.kind = 'paragraph';
  block.spans = spans;
  delete block.rows;
}

/** A short, honest account of what the conversion did, for the UI. */
export function describeConversion(result: ConvertResult): string {
  if (result.empty) return 'No text could be extracted from this PDF.';
  const parts: string[] = [];
  // Counted separately, because the figures shown beside this line list them
  // separately -- folding lists into the paragraph total made the summary
  // contradict the numbers next to it.
  const paragraphs = result.counts.paragraph ?? 0;
  if (paragraphs) parts.push(`${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}`);
  if (result.counts.list) {
    parts.push(`${result.counts.list} list item${result.counts.list === 1 ? '' : 's'}`);
  }
  if (result.counts.heading) {
    parts.push(`${result.counts.heading} heading${result.counts.heading === 1 ? '' : 's'}`);
  }
  if (result.counts.table) {
    parts.push(`${result.counts.table} table${result.counts.table === 1 ? '' : 's'}`);
  }
  if (result.counts.image) {
    parts.push(`${result.counts.image} image${result.counts.image === 1 ? '' : 's'}`);
  }
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : parts[0] ?? 'no content';
  return `Recovered ${list} from ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}.`;
}

/**
 * What this conversion cannot do, stated up front rather than discovered.
 *
 * A PDF records where ink went, not what the author meant, so everything here
 * is a limit of the format rather than of the effort spent on it.
 */
/** A note about the furniture that was left out, when any was. */
export function describeFurniture(result: ConvertResult): string {
  if (!result.furnitureDropped) return '';
  const lines = result.furnitureDropped;
  return `Left out ${lines} repeated header or footer line${lines === 1 ? '' : 's'}, which would otherwise appear between the paragraphs on every page.`;
}

export const CONVERT_CAVEATS = [
  'A scanned PDF has no text to extract — it needs OCR, which this tool does not do',
  'Paragraphs, headings, lists and tables are inferred from spacing and alignment, because a PDF records none of them',
  'Borderless tables and side-by-side columns are the two layouts most likely to come out wrong',
  'Running headers and footers are detected by repetition and left out, rather than reproduced as real Word headers',
  'Colours, highlighting and text boxes are not carried over',
] as const;
