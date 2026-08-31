/**
 * Reads the paragraph properties mammoth throws away.
 *
 * mammoth is a semantic converter: it recovers what a document MEANS and
 * deliberately discards how it LOOKS. That is the right call for its purpose
 * and the wrong one for ours, so the appearance properties are read straight
 * out of word/document.xml here and merged back onto the blocks mammoth
 * produced.
 *
 * Scope is deliberate. This reads alignment, size, indents, tab stops and page
 * setup — the things you actually notice on a CV. Lists, tables and images stay
 * with mammoth, because their structure is genuinely hard and it already does
 * it well.
 *
 * Regex-based rather than DOM-based so it runs identically in Node and the
 * browser. Pure; covered by scripts/test-tools.mjs.
 */

/** OOXML measures in twentieths of a point. */
import { readRunSpans, type RunSpan } from './runs.ts';

export const TWIP = 1 / 20;
export const twips = (value: string | undefined): number =>
  value === undefined ? 0 : (Number(value) || 0) * TWIP;

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface TabStop {
  /** Position in points from the left text edge. */
  pos: number;
  align: 'left' | 'center' | 'right' | 'decimal';
}

export interface ParagraphProps {
  /** Plain text, used only to line this up with the matching block. */
  text: string;
  align?: Align;
  /** Font size in points, from the paragraph's first run. */
  size?: number;
  /** Left indent in points. */
  indent?: number;
  /** First-line indent in points; negative for a hanging indent. */
  firstLine?: number;
  tabs?: TabStop[];
  /** Space before the paragraph, in points. */
  spaceBefore?: number;
  /** Space after the paragraph, in points. */
  spaceAfter?: number;
  /**
   * Line spacing as a multiple of the font's own single line height, from
   * w:line with w:lineRule="auto" (w:line is in 240ths of a line).
   */
  lineMultiple?: number;
  /** Fixed baseline-to-baseline distance in points, from "exact" or "atLeast". */
  lineExact?: number;
  /** True when lineExact came from "atLeast", so it is a floor, not a value. */
  lineAtLeast?: boolean;
  /** Suppress spacing between consecutive paragraphs of the same style. */
  contextualSpacing?: boolean;
  /** w:pStyle, so style-level defaults can be resolved. */
  styleId?: string;
  /** This paragraph starts a new page. */
  pageBreakBefore?: boolean;
  /** Per-run colour, highlight and size, with offsets into `runText`. */
  runSpans?: RunSpan[];
  /** The paragraph's raw text, which the spans index into. */
  runText?: string;
}

export interface PageSetup {
  width: number;
  height: number;
  margin: number;
}

const ALIGN: Record<string, Align> = {
  left: 'left',
  start: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  distribute: 'justify',
};

/** Value of `w:val` (or another attribute) on the first matching element. */
const attrOf = (xml: string, tag: string, name = 'w:val'): string | undefined => {
  const el = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
  if (!el) return undefined;
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(el[0]);
  return m ? m[1] : undefined;
};


/**
 * Strips table regions.
 *
 * Paragraphs inside a table are not separate blocks downstream — mammoth folds
 * them into cells — so including them here would shift every later paragraph
 * out of alignment with its block.
 */
export const withoutTables = (xml: string): string => xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, '');

/** Plain text of one `<w:p>`, matching how the block model will read it. */
export function paragraphText(paragraphXml: string): string {
  // Drop <w:pPr> first: it holds the tab-stop DEFINITIONS, whose <w:tab>
  // elements are indistinguishable by tag name from the tab characters inside
  // runs. Counting those as text prefixed a spurious tab to every paragraph
  // that declared stops, which broke correlation for exactly the paragraphs
  // whose properties matter most.
  const runsOnly = paragraphXml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, '');
  let out = '';
  for (const token of runsOnly.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g) ?? []) {
    if (token.startsWith('<w:tab')) out += '\t';
    else if (token.startsWith('<w:br')) out += '\n';
    else {
      const inner = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(token);
      if (inner) {
        out += inner[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
      }
    }
  }
  return out;
}

/** Comparable form: whitespace flattened, so minor differences do not block a match. */
export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Reads every body paragraph's appearance properties, in document order.
 *
 * Only `<w:p>` outside tables is returned, so the result lines up with the
 * paragraph-like blocks mammoth produces.
 */
export function readParagraphProps(
  documentXml: string,
  styles?: StyleDefs,
): ParagraphProps[] {
  const body = withoutTables(documentXml);
  const out: ParagraphProps[] = [];
  /** Set by an empty paragraph whose only content was a page break. */
  let pendingBreak = false;

  for (const paragraph of body.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
    const props: ParagraphProps = { text: paragraphText(paragraph) };

    // Paragraph properties sit in the first <w:pPr>, before any run.
    const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraph)?.[1] ?? '';

    // Style first, so anything the paragraph states directly overwrites it.
    const styleId = attrOf(pPr, 'w:pStyle') ?? undefined;
    if (styleId) props.styleId = styleId;
    const inherited = styleId ? styles?.byId.get(styleId) : undefined;
    if (inherited) Object.assign(props, inherited);

    /* --- explicit page breaks --- */

    if (/<w:pageBreakBefore\b(?![^>]*w:val\s*=\s*"(?:0|false)")/.test(pPr)) {
      props.pageBreakBefore = true;
    }

    // <w:br w:type="page"/> breaks at the point it appears. Word writers very
    // often put one in a paragraph of its own, and mammoth drops that paragraph
    // entirely, so the flag has to carry forward to the next one with text.
    const brIndex = paragraph.search(/<w:br\b[^>]*w:type\s*=\s*"page"/);
    if (brIndex >= 0) {
      const firstText = paragraph.search(/<w:t[\s>]/);
      if (props.text.trim() === '') pendingBreak = true;
      else if (firstText < 0 || brIndex < firstText) props.pageBreakBefore = true;
      // A break after some text splits a paragraph mid-flow, which this subset
      // does not reproduce; the text still renders, just without the break.
    }

    if (pendingBreak && props.text.trim() !== '') {
      props.pageBreakBefore = true;
      pendingBreak = false;
    }

    const jc = attrOf(pPr, 'w:jc');
    if (jc && ALIGN[jc]) props.align = ALIGN[jc];

    const indXml = /<w:ind\b[^>]*\/?>/.exec(pPr)?.[0] ?? '';
    if (indXml) {
      const left = /w:left\s*=\s*"([^"]*)"/.exec(indXml)?.[1] ?? /w:start\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
      const firstLine = /w:firstLine\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
      const hanging = /w:hanging\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
      if (left !== undefined) props.indent = twips(left);
      // A hanging indent pulls the first line back, so it is a negative offset.
      if (firstLine !== undefined) props.firstLine = twips(firstLine);
      else if (hanging !== undefined) props.firstLine = -twips(hanging);
    }

    const tabs: TabStop[] = [];
    for (const tab of pPr.match(/<w:tab\b[^>]*\/?>/g) ?? []) {
      const pos = /w:pos\s*=\s*"([^"]*)"/.exec(tab)?.[1];
      const val = /w:val\s*=\s*"([^"]*)"/.exec(tab)?.[1] ?? 'left';
      // "clear" removes an inherited stop rather than declaring one.
      if (pos === undefined || val === 'clear') continue;
      const align = val === 'right' || val === 'center' || val === 'decimal' ? val : 'left';
      tabs.push({ pos: twips(pos), align });
    }
    if (tabs.length) props.tabs = tabs.sort((a, b) => a.pos - b.pos);

    // Spacing. Ignoring this is what made a single-spaced 2-page resume come
    // out at 3 pages: Word asked for line=240 auto (one line) and after=0, and
    // the defaults here added 38% leading plus a gap before every paragraph.
    const spacingXml = /<w:spacing\b[^>]*\/?>/.exec(pPr)?.[0] ?? '';
    if (spacingXml) {
      const val = (name: string) =>
        new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(spacingXml)?.[1];
      const before = val('w:before');
      const after = val('w:after');
      const line = val('w:line');
      const rule = val('w:lineRule') ?? 'auto';

      if (before !== undefined) props.spaceBefore = Math.max(0, twips(before));
      if (after !== undefined) props.spaceAfter = Math.max(0, twips(after));

      if (line !== undefined) {
        if (rule === 'exact' || rule === 'atLeast') {
          props.lineExact = Math.max(0, twips(line));
          props.lineAtLeast = rule === 'atLeast';
        } else {
          // 240ths of a line, so 240 is single and 360 is one-and-a-half.
          const multiple = (Number(line) || 240) / 240;
          if (multiple > 0 && multiple < 10) props.lineMultiple = multiple;
        }
      }
    }

    // <w:contextualSpacing/> is on; an explicit w:val="0" turns it off again.
    const ctx = /<w:contextualSpacing\b([^>]*)\/?>/.exec(pPr);
    if (ctx && !/w:val\s*=\s*"(0|false)"/.test(ctx[1])) props.contextualSpacing = true;

    // Size: half-points, taken from the paragraph mark or its first run. A
    // paragraph mixing sizes therefore takes its first run's — reading every
    // run would mean owning run parsing too, which this subset does not.
    const sz =
      attrOf(pPr, 'w:sz') ??
      attrOf(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/.exec(paragraph)?.[0] ?? '', 'w:sz');
    if (sz) {
      const points = (Number(sz) || 0) / 2;
      if (points >= 4 && points <= 200) props.size = points;
    }

    // Run-level colour, highlight and size. Recorded with the raw text so the
    // caller can align it against the block's whitespace-collapsed runs.
    const runs = readRunSpans(paragraph);
    if (runs.spans.length) {
      props.runSpans = runs.spans;
      props.runText = runs.text;
    }

    out.push(props);
  }
  return out;
}

/**
 * Page size and margins from the final `<w:sectPr>`.
 *
 * A single margin is derived from the smallest of the four, because the layout
 * pass uses one uniform margin; taking the largest would crush the text column
 * on a document with a wide binding edge.
 */
export function readPageSetup(documentXml: string): PageSetup | null {
  const sect = /<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/.exec(documentXml)?.[0];
  if (!sect) return null;

  const pgSz = /<w:pgSz\b[^>]*\/?>/.exec(sect)?.[0] ?? '';
  const w = twips(/w:w\s*=\s*"([^"]*)"/.exec(pgSz)?.[1]);
  const h = twips(/w:h\s*=\s*"([^"]*)"/.exec(pgSz)?.[1]);
  if (!(w > 72 && h > 72)) return null;

  const landscape = /w:orient\s*=\s*"landscape"/.test(pgSz);
  const width = landscape ? Math.max(w, h) : Math.min(w, h);
  const height = landscape ? Math.min(w, h) : Math.max(w, h);

  const pgMar = /<w:pgMar\b[^>]*\/?>/.exec(sect)?.[0] ?? '';
  const sides = ['w:left', 'w:right', 'w:top', 'w:bottom']
    .map((name) => twips(new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(pgMar)?.[1]))
    .filter((n) => n > 0);

  const margin = sides.length ? Math.min(...sides) : 64;
  // Never leave less than a third of the page for text.
  return { width, height, margin: Math.min(margin, Math.min(width, height) / 3) };
}

/**
 * Attaches properties to blocks by matching their text.
 *
 * Correlation is by content, not position. If the texts stop agreeing — because
 * mammoth merged, split or skipped something — the remaining properties are
 * simply not applied. That degrades to the previous behaviour rather than
 * confidently formatting the wrong paragraph.
 */
export function correlate<T extends { kind: string; runs?: { text: string }[] }>(
  blocks: T[],
  props: ParagraphProps[],
): { applied: number; skipped: number; attach: (block: T) => ParagraphProps | undefined } {
  const map = new Map<T, ParagraphProps>();
  let cursor = 0;
  let applied = 0;
  let skipped = 0;

  for (const block of blocks) {
    if (!block.runs || (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'listItem')) {
      continue;
    }
    const wanted = normalizeText(block.runs.map((r) => r.text).join(''));
    if (!wanted) continue;

    // Look ahead a little: mammoth drops empty paragraphs that are still in the XML.
    let found = -1;
    for (let i = cursor; i < Math.min(props.length, cursor + 12); i++) {
      if (normalizeText(props[i].text) === wanted) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      skipped++;
      continue;
    }
    map.set(block, props[found]);
    cursor = found + 1;
    applied++;
  }

  return { applied, skipped, attach: (block) => map.get(block) };
}

/** EMUs per point. Word stores drawing sizes in English Metric Units. */
export const EMU = 914400 / 72;

export interface ImageExtent {
  /** Display width in points, as Word showed it. */
  width: number;
  height: number;
}

/**
 * The display size of each image, in document order.
 *
 * This is the fix for an 8-page resume. Without it, layout has no idea how big
 * an image is and reserved the full text width at a hardcoded 4:3 ratio — about
 * 425pt. Resume templates draw their section dividers as images 1pt tall, so
 * eight rules cost four blank pages.
 *
 * `mc:Fallback` is stripped first. A drawing wrapped in mc:AlternateContent
 * appears twice, once per branch, so counting raw <wp:extent> gives exactly
 * double and every image would take the next image's size.
 */
export function readImageExtents(documentXml: string): ImageExtent[] {
  const primary = documentXml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const out: ImageExtent[] = [];
  for (const m of primary.matchAll(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/g)) {
    const width = Number(m[1]) / EMU;
    const height = Number(m[2]) / EMU;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      out.push({ width, height });
    } else {
      // Keep the slot so later images do not shift onto the wrong extent.
      out.push({ width: 0, height: 0 });
    }
  }
  return out;
}

/**
 * Intrinsic pixel size straight out of the image bytes, as a fallback for
 * documents that declare no extent. Pure header parsing — no canvas, so it
 * works in Node and in a worker.
 *
 * Pixels are treated as 96dpi, which is what Word assumes when it places an
 * image at its natural size.
 */
export function intrinsicSize(dataUri: string): ImageExtent | null {
  const comma = dataUri.indexOf(',');
  if (comma < 0) return null;
  let bytes: Uint8Array;
  try {
    const raw = dataUri.slice(comma + 1);
    if (typeof atob === 'function') {
      const bin = atob(raw);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    }
  } catch {
    return null;
  }

  const px = (w: number, h: number): ImageExtent => ({ width: (w * 72) / 96, height: (h * 72) / 96 });
  const be32 = (i: number) =>
    ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const be16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];

  // PNG: 8-byte signature, then an IHDR chunk whose data starts at byte 16.
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return px(be32(16), be32(20));
  }

  // JPEG: walk the segment chain to a start-of-frame marker.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // SOF0..SOF15, skipping the non-frame markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return px(be16(i + 7), be16(i + 5));
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const length = be16(i + 2);
      if (length < 2) return null;
      i += 2 + length;
    }
  }

  return null;
}

/**
 * Paragraph-level defaults a style contributes.
 *
 * Deliberately excludes anything from <w:docDefaults>. Two reasons: the tool
 * offers a body-size slider that the reader chose, and a document whose Heading
 * styles declare no size would otherwise inherit the default body size and
 * render every heading flat. Only sizes a style states explicitly are applied.
 */
export interface StyleProps {
  size?: number;
  align?: Align;
  indent?: number;
  firstLine?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  lineMultiple?: number;
  lineExact?: number;
  lineAtLeast?: boolean;
  contextualSpacing?: boolean;
}

export interface StyleDefs {
  /** By styleId, with w:basedOn chains already flattened. */
  byId: Map<string, StyleProps>;
}

/** Reads the <w:spacing>/<w:jc>/<w:ind> shape shared by styles and paragraphs. */
function readSpacingLike(pPr: string): StyleProps {
  const out: StyleProps = {};

  const jc = attrOf(pPr, 'w:jc');
  if (jc && ALIGN[jc]) out.align = ALIGN[jc];

  const indXml = /<w:ind\b[^>]*\/?>/.exec(pPr)?.[0] ?? '';
  if (indXml) {
    const left =
      /w:left\s*=\s*"([^"]*)"/.exec(indXml)?.[1] ?? /w:start\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
    const firstLine = /w:firstLine\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
    const hanging = /w:hanging\s*=\s*"([^"]*)"/.exec(indXml)?.[1];
    if (left !== undefined) out.indent = twips(left);
    if (firstLine !== undefined) out.firstLine = twips(firstLine);
    else if (hanging !== undefined) out.firstLine = -twips(hanging);
  }

  const spacingXml = /<w:spacing\b[^>]*\/?>/.exec(pPr)?.[0] ?? '';
  if (spacingXml) {
    const val = (name: string) => new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(spacingXml)?.[1];
    const before = val('w:before');
    const after = val('w:after');
    const line = val('w:line');
    const rule = val('w:lineRule') ?? 'auto';
    if (before !== undefined) out.spaceBefore = Math.max(0, twips(before));
    if (after !== undefined) out.spaceAfter = Math.max(0, twips(after));
    if (line !== undefined) {
      if (rule === 'exact' || rule === 'atLeast') {
        out.lineExact = Math.max(0, twips(line));
        out.lineAtLeast = rule === 'atLeast';
      } else {
        const multiple = (Number(line) || 240) / 240;
        if (multiple > 0 && multiple < 10) out.lineMultiple = multiple;
      }
    }
  }

  const ctx = /<w:contextualSpacing\b([^>]*)\/?>/.exec(pPr);
  if (ctx && !/w:val\s*=\s*"(0|false)"/.test(ctx[1])) out.contextualSpacing = true;

  return out;
}

/**
 * Reads word/styles.xml into flattened per-style properties.
 *
 * This is what makes headings the size the document says rather than the size
 * this tool guessed, and it also carries style-level spacing and indent, which
 * most real templates set once on a style rather than on every paragraph.
 */
export function readStyles(stylesXml: string): StyleDefs {
  const raw = new Map<string, { props: StyleProps; basedOn?: string }>();

  for (const style of stylesXml.match(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g) ?? []) {
    const open = /<w:style\b[^>]*>/.exec(style)?.[0] ?? '';
    const type = /w:type\s*=\s*"([^"]*)"/.exec(open)?.[1] ?? 'paragraph';
    if (type !== 'paragraph') continue;
    const id = /w:styleId\s*=\s*"([^"]*)"/.exec(open)?.[1];
    if (!id) continue;

    const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(style)?.[1] ?? '';
    const props = readSpacingLike(pPr);

    // Size lives in the style's run properties, in half-points.
    const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(style)?.[1] ?? '';
    const sz = attrOf(rPr, 'w:sz');
    if (sz) {
      const points = (Number(sz) || 0) / 2;
      if (points >= 4 && points <= 200) props.size = points;
    }

    raw.set(id, { props, basedOn: attrOf(style, 'w:basedOn') ?? undefined });
  }

  // Flatten w:basedOn, guarding against a cycle in a hand-edited file.
  const byId = new Map<string, StyleProps>();
  const resolve = (id: string, seen: Set<string>): StyleProps => {
    const done = byId.get(id);
    if (done) return done;
    const entry = raw.get(id);
    if (!entry || seen.has(id)) return {};
    seen.add(id);
    const parent = entry.basedOn ? resolve(entry.basedOn, seen) : {};
    const merged = { ...parent, ...entry.props };
    byId.set(id, merged);
    return merged;
  };
  for (const id of raw.keys()) resolve(id, new Set());

  return { byId };
}
