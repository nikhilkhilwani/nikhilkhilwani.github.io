/**
 * .docx -> PDF.
 *
 * mammoth recovers the document's structure as HTML, blocks.ts turns that into
 * a block model, layout.ts paginates it, and this module draws the result with
 * pdf-lib. The text stays real text: selectable, searchable, copyable.
 *
 * Line breaks now match Word closely, because the text is measured and drawn
 * with Carlito, whose advance widths are byte-identical to Calibri's. See
 * fonts.ts for why that font and why the full fontkit is required.
 *
 * Complex scripts work too. fontkit does the shaping — Devanagari conjuncts and
 * matra reordering, Arabic cursive joining — and pdf-lib passes those shaped
 * glyph ids straight through, so Hindi and Arabic render correctly as long as
 * the font is embedded as a subsetted .ttf. See fonts.ts for why that proviso
 * is the whole ballgame.
 *
 * What this is NOT: a reimplementation of Word's layout engine. Headers,
 * footers, explicit page breaks, columns and floating objects are still not
 * reproduced, and there is no bidi algorithm, so a line mixing Arabic with
 * English comes out in logical order.
 */

import { parseBlocks, unsupportedCharacters, type Block } from './blocks.ts';
import { loadFonts, browserFontSource, needsFromFlags, type FontSource, type StyleKey } from './fonts.ts';
import { LATIN, RTL_SCRIPTS, scriptFont, scriptsIn } from './scripts.ts';
import {
  readParagraphProps, readPageSetup, correlate, readImageExtents, intrinsicSize,
  type PageSetup,
} from './wordxml.ts';
import { layout, DEFAULT_SCALE, A4, type BlockAppearance, type LaidOutPage, type Measure, type PageGeometry, type TypeScale } from './layout.ts';

let cachedMammoth: Promise<typeof import('mammoth')> | null = null;
/** ~200 kB, so never at import time. */
export function loadMammoth(): Promise<typeof import('mammoth')> {
  cachedMammoth ??= import('mammoth');
  return cachedMammoth;
}

let cachedPdfLib: Promise<typeof import('@cantoo/pdf-lib')> | null = null;
export function loadPdfLib(): Promise<typeof import('@cantoo/pdf-lib')> {
  cachedPdfLib ??= import('@cantoo/pdf-lib');
  return cachedPdfLib;
}

/** Thrown for a file that is not a .docx we can read. */
export class NotADocx extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        'This does not look like a .docx file. The older .doc format is a different, binary format this tool cannot read — open it in Word and save as .docx first.',
    );
    this.name = 'NotADocx';
  }
}

export interface ConvertResult {
  bytes: Uint8Array;
  pages: number;
  blocks: number;
  /** Characters the built-in fonts cannot draw, so the UI can be honest. */
  unsupported: string[];
  /** Warnings mammoth raised about the source document. */
  notes: string[];
  imagesDropped: number;
  /** Clickable hyperlinks written into the PDF. */
  links: number;
  /** Paragraphs whose Word appearance was recovered and applied. */
  styled: number;
  /** Paragraphs where the text did not line up, so defaults were kept. */
  unstyled: number;
  /** Page setup taken from the document, when it had any. */
  pageSetup: PageSetup | null;
  /**
   * True when Carlito was embedded, so widths match Word. False means the font
   * files could not be loaded and the WinAnsi built-ins were used instead.
   */
  metricFonts: boolean;
  /** Non-Latin scripts drawn with a real font for that script. */
  scripts: string[];
  /** Non-Latin scripts present whose font could not be loaded. */
  scriptsMissing: string[];
  /** True when a right-to-left script is present, where mixed lines need bidi. */
  rtl: boolean;
  /**
   * The display size finally used for each image, in document order.
   *
   * Exposed because the correlation between wp:extent and mammoth's image
   * blocks is positional, and an off-by-one there is invisible in the output
   * whenever the images happen to share a size — which is exactly the case in
   * the resume that surfaced the bug.
   */
  imageSizes: { width: number; height: number }[];
}

export interface ConvertOptions {
  geometry?: PageGeometry;
  scale?: TypeScale;
  /**
   * Take page size and margins from the document itself when it declares them.
   * The explicit `geometry` is the fallback for documents that do not.
   */
  useDocumentPageSetup?: boolean;
  /**
   * Where the metric-compatible fonts come from. Defaults to fetching
   * /fonts/*.ttf; scripts/test-pdf.mjs injects a reader so CI exercises the
   * real embedding path without a browser.
   */
  fontSource?: FontSource;
}

/** A .docx is a ZIP; every one starts with the local file header "PK\x03\x04". */
export function looksLikeDocx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function docxToPdf(
  input: Uint8Array,
  {
    geometry = A4,
    scale = DEFAULT_SCALE,
    useDocumentPageSetup = true,
    fontSource = browserFontSource(),
  }: ConvertOptions = {},
): Promise<ConvertResult> {
  if (!looksLikeDocx(input)) throw new NotADocx();

  const mammoth = await loadMammoth();

  let html: string;
  const notes: string[] = [];
  try {
    // A fresh copy: mammoth reads the buffer and we must not hand it our view.
    //
    // Both keys are supplied deliberately. mammoth's browser build looks for
    // `arrayBuffer` and its Node build looks for `buffer`, rejecting anything
    // else with "Could not find file in options" — and this module has to work
    // in both, since scripts/test-pdf.mjs converts a .docx in CI.
    const copy = input.slice();
    const converted = await mammoth.convertToHtml({
      arrayBuffer: copy.buffer as ArrayBuffer,
      buffer: copy,
    } as Parameters<typeof mammoth.convertToHtml>[0]);
    html = converted.value;
    for (const message of converted.messages) {
      // Undefined-style warnings are noise for a reader; keep real problems.
      if (!/style with ID .* was referenced but not defined/i.test(message.message)) {
        notes.push(message.message);
      }
    }
  } catch (err) {
    throw new NotADocx(
      err instanceof Error ? `Could not read that .docx: ${err.message}` : undefined,
    );
  }

  const blocks = parseBlocks(html);
  if (!blocks.length) {
    throw new NotADocx('That document appears to be empty — there is no text or image to convert.');
  }

  /* ---- appearance mammoth discards, read straight from the document ---- */

  // A second pass over the same file. It cannot fail the conversion: if the XML
  // is unreadable or the paragraphs do not line up, the document simply renders
  // with defaults, exactly as it did before this existed.
  let appearanceFor: ((block: Block) => BlockAppearance | undefined) | undefined;
  let styled = 0;
  let unstyled = 0;
  let pageSetup: PageSetup | null = null;

  try {
    const { unzipSync, strFromU8 } = await import('fflate');
    const entries = unzipSync(input.slice(), { filter: (f) => f.name === 'word/document.xml' });
    const documentXml = entries['word/document.xml'] ? strFromU8(entries['word/document.xml']) : '';

    if (documentXml) {
      // Image display sizes, matched to the image blocks in document order.
      // mammoth drops them, and without them layout has to guess.
      const extents = readImageExtents(documentXml);
      let nth = 0;
      for (const block of blocks) {
        if (block.kind !== 'image') continue;
        const declared = extents[nth++];
        if (declared && declared.width > 0 && declared.height > 0) {
          block.width = declared.width;
          block.height = declared.height;
        }
      }

      pageSetup = readPageSetup(documentXml);
      const props = readParagraphProps(documentXml);
      const matched = correlate(blocks, props);
      styled = matched.applied;
      unstyled = matched.skipped;
      appearanceFor = (block) => {
        const p = matched.attach(block);
        if (!p) return undefined;
        return { align: p.align, size: p.size, indent: p.indent, firstLine: p.firstLine, tabs: p.tabs };
      };
    }
  } catch {
    // Deliberately silent: this is an enhancement, not a requirement.
  }

  // Anything the document did not declare falls back to the image's intrinsic
  // pixel size, which still beats a hardcoded 4:3 guess at full column width.
  for (const block of blocks) {
    if (block.kind !== 'image' || (block.width && block.height)) continue;
    const size = intrinsicSize(block.dataUri);
    if (size && size.width > 0 && size.height > 0) {
      block.width = size.width;
      block.height = size.height;
    }
  }

  // Named to avoid colliding with the `page` loop variable below.
  const pageBox = useDocumentPageSetup && pageSetup ? pageSetup : geometry;


  const { PDFDocument, StandardFonts, rgb, PDFString } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  pdf.setProducer('nikhilkhilwani.github.io/tools/word-to-pdf');

  // Only the faces the document actually uses get fetched: a document with no
  // italics never pays for the italic file.
  const runFlags: { bold?: boolean; italic?: boolean }[] = [];
  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row) runFlags.push(...cell.runs);
    } else if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') {
      runFlags.push(...block.runs);
    }
  }

  // Every non-Latin script in the document, so only the fonts actually needed
  // are fetched. A pure-English document pulls nothing beyond Carlito.
  const scripts = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row) for (const run of cell.runs) for (const k of scriptsIn(run.text)) scripts.add(k);
      }
    } else if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') {
      for (const run of block.runs) for (const k of scriptsIn(run.text)) scripts.add(k);
    }
  }

  const loaded = await loadFonts(pdf, needsFromFlags(runFlags), scripts, fontSource);

  const fallback = loaded
    ? null
    : {
        // Fallback only. WinAnsi-encoded, and metrics unlike Word's — this is
        // what every conversion looked like before fonts.ts existed.
        regular: await pdf.embedFont(StandardFonts.TimesRoman),
        bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
        italic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
        boldItalic: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic),
      };

  // Asked of the embedded fonts directly when there are any, so the warning
  // reflects what can really be drawn rather than assuming the WinAnsi set.
  const unsupported = unsupportedCharacters(blocks, loaded?.hasGlyph);

  const styleKey = (bold: boolean, italic: boolean): StyleKey =>
    bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';

  /**
   * The face for one piece. A piece carries the script key layout resolved for
   * it; if that script's font failed to load, Latin draws it and the characters
   * come out as "?" — which unsupportedCharacters has already reported.
   */
  const pick = (font: string, bold: boolean, italic: boolean) => {
    if (fallback) return fallback[styleKey(bold, italic)];
    const sets = loaded!.sets;
    const set = sets.get(font) ?? sets.get(LATIN)!;
    return set.faces[styleKey(bold, italic)];
  };

  // Anything the fonts cannot encode is replaced before measuring, so the
  // widths used for layout match what actually gets drawn.
  const safe = (text: string): string =>
    unsupported.length ? [...text].map((ch) => (unsupported.includes(ch) ? '?' : ch)).join('') : text;

  const measure: Measure = (text, style) => {
    try {
      return pick(style.font, style.bold, style.italic).widthOfTextAtSize(safe(text), style.size);
    } catch {
      // Never let a measurement failure abort the whole conversion.
      return text.length * style.size * 0.5;
    }
  };

  const laid: LaidOutPage[] = layout(blocks, {
    geometry: pageBox,
    scale,
    measure,
    maxImageWidth: pageBox.width - pageBox.margin * 2,
    appearance: appearanceFor,
  });

  let imagesDropped = 0;
  let links = 0;
  const ink = rgb(0.09, 0.09, 0.11);
  const linkInk = rgb(0.05, 0.32, 0.55);

  for (const page of laid) {
    const sheet = pdf.addPage([pageBox.width, pageBox.height]);

    for (const item of page.items) {
      if (item.kind === 'line') {
        for (const piece of item.line.pieces) {
          const x = item.x + piece.x;
          const y = item.y + piece.rise;

          if (piece.text.trim()) {
            sheet.drawText(safe(piece.text), {
              x,
              y,
              size: piece.size,
              font: pick(piece.font, piece.bold, piece.italic),
              color: piece.href ? linkInk : ink,
            });
          }

          // A link is only useful if it can be followed, so draw the rule and
          // register a real annotation rather than colouring the text and
          // hoping the reader notices.
          if (piece.href && piece.width > 0) {
            sheet.drawLine({
              start: { x, y: y - piece.size * 0.1 },
              end: { x: x + piece.width, y: y - piece.size * 0.1 },
              thickness: Math.max(0.4, piece.size * 0.045),
              color: linkInk,
            });
            const annot = pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x, y - piece.size * 0.25, x + piece.width, y + piece.size * 0.9],
              // No visible frame: the underline already signals the link.
              Border: [0, 0, 0],
              A: pdf.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(piece.href) }),
            });
            sheet.node.addAnnot(pdf.context.register(annot));
            links++;
          } else if (piece.underline && piece.width > 0) {
            sheet.drawLine({
              start: { x, y: y - piece.size * 0.1 },
              end: { x: x + piece.width, y: y - piece.size * 0.1 },
              thickness: Math.max(0.4, piece.size * 0.045),
              color: ink,
            });
          }

          if (piece.strike && piece.width > 0) {
            sheet.drawLine({
              start: { x, y: y + piece.size * 0.28 },
              end: { x: x + piece.width, y: y + piece.size * 0.28 },
              thickness: Math.max(0.4, piece.size * 0.045),
              color: ink,
            });
          }
        }
        continue;
      }

      if (item.kind === 'rule') {
        sheet.drawLine({
          start: { x: item.x, y: item.y },
          end: { x: item.x + item.width, y: item.y },
          thickness: 0.75,
          color: rgb(0.75, 0.75, 0.78),
        });
        continue;
      }

      if (item.kind === 'cellBox') {
        sheet.drawRectangle({
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          borderWidth: 0.5,
          borderColor: rgb(0.72, 0.72, 0.76),
        });
        continue;
      }

      if (item.kind === 'image') {
        try {
          const comma = item.dataUri.indexOf(',');
          const header = item.dataUri.slice(0, comma);
          const raw = atobBytes(item.dataUri.slice(comma + 1));
          const embedded = /image\/png/i.test(header)
            ? await pdf.embedPng(raw)
            : await pdf.embedJpg(raw);

          // Correct the placeholder box to the real aspect ratio.
          const ratio = embedded.height / embedded.width;
          const width = Math.min(item.width, embedded.width);
          sheet.drawImage(embedded, { x: item.x, y: item.y, width, height: width * ratio });
        } catch {
          // A format pdf-lib cannot embed (WebP, EMF, SVG) is dropped and counted.
          imagesDropped++;
        }
      }
    }
  }

  const bytes = await pdf.save();
  return {
    bytes,
    pages: pdf.getPageCount(),
    blocks: blocks.length,
    unsupported,
    notes,
    imagesDropped,
    links,
    styled,
    unstyled,
    pageSetup,
    metricFonts: loaded !== null,
    scripts: [...scripts].filter((k) => !(loaded?.missing ?? []).includes(k)),
    scriptsMissing: loaded?.missing ?? [...scripts],
    rtl: [...scripts].some((k) => RTL_SCRIPTS.has(k)),
    imageSizes: blocks
      .filter((b): b is Extract<Block, { kind: 'image' }> => b.kind === 'image')
      .map((b) => ({ width: b.width ?? 0, height: b.height ?? 0 })),
  };
}

/** base64 -> bytes, without assuming a DOM. */
function atobBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** One honest sentence about what the conversion did and did not carry over. */
export function describeConversion(result: ConvertResult): string {
  const parts = [`${result.pages} page${result.pages === 1 ? '' : 's'} from ${result.blocks} blocks.`];
  parts.push('Text is selectable and searchable.');

  if (result.scripts.length) {
    const names = result.scripts.map((k) => scriptFont(k)?.label ?? k);
    parts.push(`${names.join(', ')} rendered with an embedded font for that script.`);
  }
  if (result.rtl) {
    parts.push(
      'Right-to-left text is shaped correctly, but a line mixing it with left-to-right text is placed in logical order.',
    );
  }
  if (result.scriptsMissing.length) {
    const names = result.scriptsMissing.map((k) => scriptFont(k)?.label ?? k);
    parts.push(`Could not load a font for ${names.join(', ')}, so that text became "?".`);
  }
  if (result.unsupported.length) {
    const shown = result.unsupported.slice(0, 6).join(' ');
    // The reason differs by path, and saying the wrong one sends people looking
    // for a fix that does not exist.
    const why = result.metricFonts
      ? 'no embedded font covers them'
      : 'the font files could not be loaded, so the built-in fonts were used and those cover Latin only';
    parts.push(
      `${result.unsupported.length} character${result.unsupported.length === 1 ? '' : 's'} could not be drawn (${shown}) and became "?" — ${why}.`,
    );
  }
  if (!result.metricFonts) {
    parts.push('Line breaks may differ from Word: the metric-compatible fonts did not load.');
  }
  if (result.styled) {
    parts.push(
      `Alignment, sizes, indents and tab stops recovered for ${result.styled} paragraph${result.styled === 1 ? '' : 's'}.`,
    );
  }
  if (result.pageSetup) {
    parts.push(
      `Page size taken from the document (${Math.round(result.pageSetup.width)}x${Math.round(result.pageSetup.height)} pt).`,
    );
  }
  if (result.links) {
    parts.push(`${result.links} link${result.links === 1 ? '' : 's'} stayed clickable.`);
  }
  if (result.imagesDropped) {
    parts.push(`${result.imagesDropped} image${result.imagesDropped === 1 ? '' : 's'} in an unsupported format were left out.`);
  }
  return parts.join(' ');
}

export const LAYOUT_CAVEATS = [
  'Font colours and highlighting are not carried over, and a paragraph mixing sizes takes its first size',
  'Headers, footers, page numbers, footnotes and explicit page breaks are not carried over',
  'Columns, text boxes, shapes and vertically merged cells are not reproduced',
  'A line mixing Arabic or Hebrew with left-to-right text is laid out in logical order, not visual order',
  'Indic, Arabic, Hebrew and Thai text is drawn at a single weight — bold and italic are not synthesised for those scripts',
] as const;

export type { Block };
