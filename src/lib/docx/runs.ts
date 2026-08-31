/**
 * Run-level formatting: colours, highlighting and per-run sizes.
 *
 * mammoth throws all of this away, and worse, it MERGES adjacent runs whose
 * formatting looks identical to it — so a red run followed by a highlighted one
 * arrives as a single run with no boundary at all. Everything here exists to put
 * those boundaries back.
 *
 * The alignment is the delicate part. Offsets cannot be compared directly: the
 * block's text has been through tidyRuns, which collapses whitespace, while the
 * raw XML has not. So the two are walked in parallel matching only NON-space
 * characters, and any mismatch abandons the whole paragraph. Painting no colour
 * is a small loss; painting the right colour over the wrong words is not.
 */

import type { Run } from './blocks.ts';

/** One XML run's properties, with offsets into the paragraph's raw text. */
export interface RunSpan {
  start: number;
  /** Exclusive. */
  end: number;
  /** Six hex digits, no leading hash. */
  color?: string;
  highlight?: string;
  /** Points. */
  size?: number;
}

/** Word's named highlight colours. */
const HIGHLIGHTS: Record<string, string> = {
  black: '000000',
  blue: '0000FF',
  cyan: '00FFFF',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGray: '808080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  green: '00FF00',
  lightGray: 'C0C0C0',
  magenta: 'FF00FF',
  red: 'FF0000',
  white: 'FFFFFF',
  yellow: 'FFFF00',
};

const HEX = /^[0-9a-fA-F]{6}$/;

const attr = (xml: string, tag: string, name = 'w:val'): string | undefined => {
  const el = new RegExp('<' + tag + '\\b[^>]*/?>').exec(xml)?.[0];
  if (!el) return undefined;
  return new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(el)?.[1];
};

/** Normalises a colour attribute; "auto" and "none" mean "no colour set". */
function colorOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^#/, '');
  if (!HEX.test(hex)) return undefined;
  return hex.toUpperCase();
}

/** Hex string to the 0..1 triple pdf-lib wants. */
export function hexToUnitRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/**
 * Reads each <w:r> in one paragraph, returning the paragraph's raw text and the
 * properties covering each stretch of it.
 */
export function readRunSpans(paragraphXml: string): { text: string; spans: RunSpan[] } {
  // <w:pPr> carries the paragraph mark's own run properties and the tab-stop
  // definitions. Neither is text, and counting them shifts every offset.
  const body = paragraphXml.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, '');

  let text = '';
  const spans: RunSpan[] = [];

  for (const run of body.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) ?? []) {
    const rPr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';

    let runText = '';
    for (const token of run.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g) ?? []) {
      if (token.startsWith('<w:tab')) runText += '\t';
      else if (token.startsWith('<w:br')) runText += '\n';
      else {
        const inner = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(token);
        if (inner) {
          runText += inner[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
        }
      }
    }

    const start = text.length;
    text += runText;
    if (!runText.length) continue;

    const span: RunSpan = { start, end: text.length };

    const color = colorOf(attr(rPr, 'w:color'));
    if (color) span.color = color;

    // Either a named highlight or a shading fill; both read as a background.
    const named = attr(rPr, 'w:highlight');
    const highlight = named && HIGHLIGHTS[named] ? HIGHLIGHTS[named] : colorOf(attr(rPr, 'w:shd', 'w:fill'));
    if (highlight) span.highlight = highlight;

    const sz = attr(rPr, 'w:sz');
    if (sz) {
      const points = (Number(sz) || 0) / 2;
      if (points >= 4 && points <= 200) span.size = points;
    }

    if (span.color || span.highlight || span.size !== undefined) spans.push(span);
  }

  return { text, spans };
}

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0';

/**
 * Maps each character of `blockText` to the raw-text offset behind it, or null
 * if the two do not describe the same characters.
 *
 * Whitespace is skipped on both sides rather than counted, because tidyRuns has
 * already collapsed runs of spaces that the XML still spells out in full.
 */
export function alignOffsets(blockText: string, raw: string): number[] | null {
  const out = new Array<number>(blockText.length);
  let j = 0;
  let last = 0;

  for (let i = 0; i < blockText.length; i++) {
    const ch = blockText[i];
    if (isSpace(ch)) {
      out[i] = last;
      continue;
    }
    while (j < raw.length && isSpace(raw[j])) j++;
    if (j >= raw.length || raw[j] !== ch) return null;
    out[i] = j;
    last = j;
    j++;
  }

  while (j < raw.length && isSpace(raw[j])) j++;
  // Anything left over means the XML holds text the block does not, so the two
  // are not the same paragraph and nothing may be attributed.
  return j < raw.length ? null : out;
}

/**
 * Splits `runs` so every run falls inside a single XML run, carrying its colour,
 * highlight and size. Returns null when alignment fails, and the caller keeps
 * the original runs untouched.
 */
export function applyRunSpans(runs: Run[], raw: string, spans: RunSpan[]): Run[] | null {
  if (!spans.length) return null;

  const blockText = runs.map((r) => r.text).join('');
  const map = alignOffsets(blockText, raw);
  if (!map) return null;

  /** The span covering a raw offset, if any. */
  const spanAt = (offset: number): RunSpan | undefined =>
    spans.find((s) => offset >= s.start && offset < s.end);

  const out: Run[] = [];
  let cursor = 0;

  for (const run of runs) {
    let piece = '';
    let current: RunSpan | undefined;
    let started = false;

    const push = () => {
      if (!piece) return;
      const next: Run = { ...run, text: piece };
      if (current?.color) next.color = current.color;
      if (current?.highlight) next.highlight = current.highlight;
      if (current?.size !== undefined) next.size = current.size;
      out.push(next);
      piece = '';
    };

    for (let i = 0; i < run.text.length; i++) {
      const span = spanAt(map[cursor + i]);
      if (!started) {
        current = span;
        started = true;
      } else if (span !== current) {
        push();
        current = span;
      }
      piece += run.text[i];
    }
    push();
    cursor += run.text.length;
  }

  return out;
}

/** One cell's combined text and the run properties covering it. */
export interface CellRuns {
  text: string;
  spans: RunSpan[];
}

/**
 * Run properties for every table cell, as [table][row][cell] in document order.
 *
 * readParagraphProps strips tables before parsing, so cell text never entered
 * the paragraph correlation and got no colour, highlight or per-run size. Rather
 * than matching cell text against a paragraph stream, this walks the table
 * structure directly — a cell is identified by where it sits, not by what it
 * says, so two cells reading "Yes" cannot be confused.
 *
 * A cell holding several paragraphs is concatenated with no separator, which is
 * exactly what blocks.ts does when it flattens a cell into one run list.
 *
 * Vertical-merge continuation cells are skipped, because mammoth omits them.
 * Keeping them would make every row after a vMerge one cell too long and the
 * count check below would throw the whole table away.
 */
export function readTableCellRuns(documentXml: string): CellRuns[][][] {
  const tables: CellRuns[][][] = [];

  for (const tbl of documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows: CellRuns[][] = [];

    for (const tr of tbl.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g) ?? []) {
      const cells: CellRuns[] = [];

      for (const tc of tr.match(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) ?? []) {
        const tcPr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tc)?.[1] ?? '';
        const vMerge = /<w:vMerge\b([^>]*)\/?>/.exec(tcPr);
        if (vMerge && !/w:val\s*=\s*"restart"/.test(vMerge[1])) continue;

        let text = '';
        const spans: RunSpan[] = [];
        for (const paragraph of tc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []) {
          const read = readRunSpans(paragraph);
          const shift = text.length;
          for (const span of read.spans) {
            spans.push({ ...span, start: span.start + shift, end: span.end + shift });
          }
          text += read.text;
        }
        cells.push({ text, spans });
      }

      rows.push(cells);
    }

    tables.push(rows);
  }

  return tables;
}
