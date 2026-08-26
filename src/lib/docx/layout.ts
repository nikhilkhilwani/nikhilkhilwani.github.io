/**
 * Page layout for the block model: line breaking, pagination, lists, tables.
 *
 * The font measurer is injected, so this whole pass is pure and runs anywhere.
 * That is what makes pagination testable without a PDF library — and
 * pagination is exactly the part that goes wrong silently.
 *
 * Covered by scripts/test-tools.mjs.
 */

import type { Block, Run } from './blocks.ts';

/** Width of `text` at `size` in the given style. Supplied by the renderer. */
export type Measure = (text: string, style: { bold: boolean; italic: boolean; size: number }) => number;

export interface PageGeometry {
  width: number;
  height: number;
  margin: number;
}

/** A4 in PDF points, with a margin close to Word's default 1 inch. */
export const A4: PageGeometry = { width: 595.28, height: 841.89, margin: 64 };
export const LETTER: PageGeometry = { width: 612, height: 792, margin: 64 };

export const PAGE_SIZES: { id: string; label: string; geometry: PageGeometry }[] = [
  { id: 'a4', label: 'A4 — 210 × 297 mm', geometry: A4 },
  { id: 'letter', label: 'US Letter — 8.5 × 11 in', geometry: LETTER },
];

export interface TypeScale {
  body: number;
  h1: number;
  h2: number;
  h3: number;
  /** Multiplied by the font size to get the baseline-to-baseline distance. */
  lineHeight: number;
}

export const DEFAULT_SCALE: TypeScale = { body: 11, h1: 20, h2: 15.5, h3: 12.5, lineHeight: 1.38 };

/** A run positioned on a line. */
export interface Piece {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  x: number;
}

export interface Line {
  pieces: Piece[];
  /** Baseline offset from the top of the line box. */
  size: number;
  height: number;
}

export type Drawn =
  | { kind: 'line'; x: number; y: number; line: Line }
  | { kind: 'image'; x: number; y: number; width: number; height: number; dataUri: string }
  | { kind: 'rule'; x: number; y: number; width: number }
  | { kind: 'cellBox'; x: number; y: number; width: number; height: number };

export interface LaidOutPage {
  items: Drawn[];
}

export interface LayoutOptions {
  geometry: PageGeometry;
  scale: TypeScale;
  measure: Measure;
  /** Longest edge an image may occupy, in points. */
  maxImageWidth?: number;
}

const sizeFor = (block: Block, scale: TypeScale): number => {
  if (block.kind === 'heading') {
    return block.level === 1 ? scale.h1 : block.level === 2 ? scale.h2 : scale.h3;
  }
  return scale.body;
};

/**
 * Breaks styled runs into lines that fit `width`.
 *
 * Wrapping happens across runs, not within them, so a bold word in the middle
 * of a sentence does not force a break. A single word longer than the line is
 * placed anyway rather than looping forever.
 */
export function wrapRuns(
  runs: Run[],
  size: number,
  width: number,
  measure: Measure,
): Line[] {
  const lines: Line[] = [];
  let pieces: Piece[] = [];
  let x = 0;

  const flush = () => {
    if (pieces.length) lines.push({ pieces, size, height: size });
    pieces = [];
    x = 0;
  };

  for (const run of runs) {
    const style = { bold: !!run.bold, italic: !!run.italic, size };
    // Keep the separators so spacing between runs survives.
    const words = run.text.split(/(\s+)/).filter((w) => w.length);

    for (const word of words) {
      const w = measure(word, style);

      if (/^\s+$/.test(word)) {
        // Never start a line with whitespace.
        if (x > 0) {
          pieces.push({ text: word, ...style, x });
          x += w;
        }
        continue;
      }

      if (x + w > width && x > 0) {
        // Drop any trailing space before breaking.
        while (pieces.length && /^\s+$/.test(pieces[pieces.length - 1].text)) {
          const removed = pieces.pop()!;
          x -= measure(removed.text, { bold: removed.bold, italic: removed.italic, size });
        }
        flush();
      }

      pieces.push({ text: word, ...style, x });
      x += w;
    }
  }

  flush();
  return lines;
}

/** Equal columns, which is predictable and never overflows the text area. */
export function columnWidths(columns: number, available: number, gap = 8): number[] {
  if (columns <= 0) return [];
  const each = (available - gap * (columns - 1)) / columns;
  return Array.from({ length: columns }, () => Math.max(24, each));
}

/**
 * Flows blocks onto pages.
 *
 * Two rules make the output read like a document rather than a dump: a heading
 * is never left alone at the foot of a page, and a table row is never split
 * across a page break.
 */
export function layout(blocks: Block[], options: LayoutOptions): LaidOutPage[] {
  const { geometry, scale, measure } = options;
  const textWidth = geometry.width - geometry.margin * 2;
  const bottom = geometry.margin;

  const pages: LaidOutPage[] = [];
  let items: Drawn[] = [];
  let y = geometry.height - geometry.margin;

  const newPage = () => {
    pages.push({ items });
    items = [];
    y = geometry.height - geometry.margin;
  };
  const room = (needed: number) => y - needed >= bottom;

  for (const [index, block] of blocks.entries()) {
    const size = sizeFor(block, scale);
    const lineHeight = size * scale.lineHeight;

    if (block.kind === 'rule') {
      if (!room(14)) newPage();
      y -= 8;
      items.push({ kind: 'rule', x: geometry.margin, y, width: textWidth });
      y -= 6;
      continue;
    }

    if (block.kind === 'image') {
      // Without intrinsic dimensions here, assume a sensible printed width and
      // let the renderer correct the aspect ratio.
      const width = Math.min(options.maxImageWidth ?? textWidth, textWidth);
      const height = width * 0.75;
      if (!room(height + 12)) newPage();
      y -= 6;
      items.push({ kind: 'image', x: geometry.margin, y: y - height, width, height, dataUri: block.dataUri });
      y -= height + 6;
      continue;
    }

    if (block.kind === 'table') {
      const columns = Math.max(...block.rows.map((r) => r.length), 1);
      const widths = columnWidths(columns, textWidth);
      const padding = 4;

      for (const row of block.rows) {
        // Wrap every cell first so the row height is known before committing.
        const cells = row.map((cell, c) => wrapRuns(cell, scale.body, widths[c] - padding * 2, measure));
        const rowHeight = Math.max(
          scale.body * scale.lineHeight,
          ...cells.map((lines) => lines.length * scale.body * scale.lineHeight),
        ) + padding * 2;

        // A row split across pages is unreadable, so move the whole row.
        if (!room(rowHeight)) newPage();

        let x = geometry.margin;
        for (const [c, lines] of cells.entries()) {
          items.push({ kind: 'cellBox', x, y: y - rowHeight, width: widths[c], height: rowHeight });
          let ty = y - padding - scale.body;
          for (const line of lines) {
            items.push({ kind: 'line', x: x + padding, y: ty, line });
            ty -= scale.body * scale.lineHeight;
          }
          x += widths[c] + 8;
        }
        y -= rowHeight;
      }
      y -= 8;
      continue;
    }

    /* --- heading, paragraph, list item --- */

    const indent = block.kind === 'listItem' ? 18 * block.level : 0;
    const markerWidth = block.kind === 'listItem' ? 16 : 0;
    const lines = wrapRuns(block.runs, size, textWidth - indent - markerWidth, measure);
    if (!lines.length) continue;

    const spaceBefore = block.kind === 'heading' ? size * 0.85 : scale.body * 0.5;

    // Keep a heading with the first line of whatever follows it.
    const needed =
      block.kind === 'heading'
        ? spaceBefore + lines.length * lineHeight + scale.body * scale.lineHeight
        : spaceBefore + lineHeight;

    if (!room(needed) && items.length) newPage();
    else y -= spaceBefore;

    for (const [i, line] of lines.entries()) {
      if (!room(lineHeight) && items.length) newPage();
      y -= size;

      if (block.kind === 'listItem' && i === 0) {
        items.push({
          kind: 'line',
          x: geometry.margin + indent,
          y,
          line: {
            size,
            height: size,
            pieces: [{ text: block.marker, bold: false, italic: false, size, x: 0 }],
          },
        });
      }
      items.push({ kind: 'line', x: geometry.margin + indent + markerWidth, y, line });
      y -= lineHeight - size;
    }

    // A little air after a heading, so it binds to the text below it.
    if (block.kind === 'heading' && blocks[index + 1]) y -= size * 0.25;
  }

  pages.push({ items });
  return pages.filter((p) => p.items.length);
}
