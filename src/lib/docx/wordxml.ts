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
export function readParagraphProps(documentXml: string): ParagraphProps[] {
  const body = withoutTables(documentXml);
  const out: ParagraphProps[] = [];

  for (const paragraph of body.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
    const props: ParagraphProps = { text: paragraphText(paragraph) };

    // Paragraph properties sit in the first <w:pPr>, before any run.
    const pPr = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraph)?.[1] ?? '';

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
