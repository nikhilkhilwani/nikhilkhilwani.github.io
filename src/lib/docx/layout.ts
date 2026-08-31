/**
 * Page layout for the block model: line breaking, tab stops, pagination,
 * lists, tables.
 *
 * The font measurer is injected, so this whole pass is pure and runs anywhere.
 * That is what makes pagination testable without a PDF library — and
 * pagination is exactly the part that goes wrong silently.
 *
 * Covered by scripts/test-tools.mjs.
 */

import type { Block, Cell, Run } from './blocks.ts';
import type { Align, TabStop } from './wordxml.ts';
import { LATIN, segmentByScript } from './scripts.ts';

/** Width of `text` at `size` in the given style. Supplied by the renderer. */
export type Measure = (
  text: string,
  style: { bold: boolean; italic: boolean; size: number; font: string },
) => number;

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

/**
 * Word's default tab stops sit every half inch. Used only when the paragraph
 * declares no stops of its own; wordxml.ts reads the real ones straight out of
 * document.xml.
 */
export const TAB_WIDTH = 36;

export interface TypeScale {
  body: number;
  h1: number;
  h2: number;
  h3: number;
  /** Multiplied by the font size to get the baseline-to-baseline distance. */
  lineHeight: number;
  /**
   * The font's OWN single line height, as a multiple of the font size. Word's
   * "single" spacing means exactly this, so it is what w:line/240 multiplies.
   * Carlito is 1.2207; the fallback matches it because Carlito is the body face.
   */
  singleLine?: number;
}

export const DEFAULT_SCALE: TypeScale = {
  body: 11,
  h1: 20,
  h2: 15.5,
  h3: 12.5,
  lineHeight: 1.38,
  singleLine: 1.2207,
};

/** Superscript and subscript are drawn at this fraction of the body size. */
export const SCRIPT_SCALE = 0.72;

/** A run positioned on a line. */
export interface Piece {
  text: string;
  /**
   * Script key from scripts.ts naming the font this piece must be drawn with.
   * A piece never spans two scripts, because one piece is one drawText call.
   */
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  script?: 'super' | 'sub';
  href?: string;
  /** Six hex digits for the glyphs, when the run set one. */
  color?: string;
  /** Six hex digits painted behind the glyphs. */
  highlight?: string;
  size: number;
  x: number;
  /** Measured width, so the renderer can draw rules and link targets. */
  width: number;
  /** Baseline shift for super/subscript. */
  rise: number;
}

export interface Line {
  pieces: Piece[];
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
  /** Text columns to flow through before starting a new page. */
  columns?: number;
  /** Gutter between those columns, in points. */
  columnGap?: number;
  /**
   * Extra space to keep clear at the top and bottom of every page, on top of
   * the margin. This is how a header and footer reserve their band without the
   * body flowing underneath them.
   */
  insetTop?: number;
  insetBottom?: number;
  /**
   * Appearance read from word/document.xml, keyed by block. Absent entries
   * simply fall back to the defaults, so a correlation miss is harmless.
   */
  appearance?: (block: Block) => BlockAppearance | undefined;
}

/** The subset of Word paragraph properties this layout honours. */
export interface BlockAppearance {
  align?: Align;
  /** Space before/after in points, straight from w:spacing. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Line spacing as a multiple of the font's single line height. */
  lineMultiple?: number;
  /** Fixed line height in points. */
  lineExact?: number;
  /** lineExact is a floor rather than an exact value. */
  lineAtLeast?: boolean;
  /** Drop the gap between consecutive paragraphs of the same kind. */
  contextualSpacing?: boolean;
  /** Start this block on a fresh page. */
  pageBreakBefore?: boolean;
  /** Overrides the type scale for this block. */
  size?: number;
  /** Left indent in points. */
  indent?: number;
  /** First-line offset; negative hangs. */
  firstLine?: number;
  tabs?: TabStop[];
}

const sizeFor = (block: Block, scale: TypeScale): number => {
  if (block.kind === 'heading') {
    return block.level === 1 ? scale.h1 : block.level === 2 ? scale.h2 : scale.h3;
  }
  return scale.body;
};

/** Next tab stop strictly after `x`, measured from the block's left edge. */
export const nextTabStop = (x: number, width = TAB_WIDTH): number =>
  (Math.floor(x / width) + 1) * width;

/**
 * Breaks styled runs into lines that fit `width`.
 *
 * Wrapping happens across runs, not within them, so a bold word mid-sentence
 * does not force a break. Beyond plain words it honours:
 *   \t  advances to the next tab stop — what makes a CV's dates line up
 *   \n  breaks the line where the author asked
 *   super/subscript runs, measured at their reduced size
 *
 * `tabs` are the stops declared by the paragraph itself. A RIGHT stop is the
 * one that matters most: Word CVs put the date on a right stop at the margin,
 * and the text after such a tab has to end at that position rather than start
 * there. Without stops, Word's default half-inch grid is used.
 *
 * A single word wider than the line is placed anyway rather than looping.
 */
export function wrapRuns(
  runs: Run[],
  size: number,
  width: number,
  measure: Measure,
  tabs: TabStop[] = [],
): Line[] {
  const lines: Line[] = [];
  let pieces: Piece[] = [];
  let x = 0;

  const flush = () => {
    while (pieces.length && /^ +$/.test(pieces[pieces.length - 1].text)) pieces.pop();
    // Height follows the tallest piece. Normally every piece is the paragraph
    // size (super/subscript are smaller), so this changes nothing unless a run
    // declared a larger size of its own.
    const tallest = pieces.reduce((m, piece) => Math.max(m, piece.size), size);
    lines.push({ pieces, size, height: tallest });
    pieces = [];
    x = 0;
  };

  /** Width of everything from `from` until the next tab or the end. */
  const segmentWidth = (tokens: { text: string; w: number }[], from: number): number => {
    let total = 0;
    for (let i = from; i < tokens.length; i++) {
      if (tokens[i].text === '\t' || tokens[i].text === '\n') break;
      total += tokens[i].w;
    }
    return total;
  };

  // Flatten to tokens first, so a right-aligned tab can measure what follows it.
  const tokens: {
    text: string;
    w: number;
    run: Run;
    // Colour and highlight ride along in `style` so the three piece-construction
    // sites below pick them up from the same spread. measure() ignores them.
    style: {
      bold: boolean;
      italic: boolean;
      size: number;
      font: string;
      color?: string;
      highlight?: string;
    };
    rise: number;
  }[] = [];
  for (const run of runs) {
    // A run may declare its own size, which is how a paragraph mixing sizes
    // stops collapsing to whatever its first run happened to be.
    const base = run.size ?? size;
    const scripted = run.script ? base * SCRIPT_SCALE : base;
    const rise = run.script === 'super' ? base * 0.33 : run.script === 'sub' ? -base * 0.16 : 0;
    // Cut at script boundaries BEFORE tokenising. One piece becomes one
    // drawText call with one font, so no piece may straddle two scripts.
    // segmentByScript keeps clusters intact, so this never splits a
    // Devanagari conjunct or breaks Arabic joining.
    for (const segment of segmentByScript(run.text)) {
      const style = {
        bold: !!run.bold,
        italic: !!run.italic,
        size: scripted,
        font: segment.script,
        color: run.color,
        highlight: run.highlight,
      };
      for (const text of segment.text.split(/(\t|\n|[^\S\t\n]+)/).filter((t) => t.length)) {
        const w = text === '\t' || text === '\n' ? 0 : measure(text, style);
        tokens.push({ text, w, run, style, rise });
      }
    }
  }

  for (const [index, token] of tokens.entries()) {
    const { text, w, run, style, rise } = token;

    if (text === '\n') {
      flush();
      continue;
    }

    if (text === '\t') {
      const stop = tabs.find((t) => t.pos > x + 0.01);
      let target: number;

      if (stop && stop.align === 'right') {
        // Place the following text so it ENDS on the stop.
        const following = segmentWidth(tokens, index + 1);
        target = Math.max(x, Math.min(stop.pos, width) - following);
      } else if (stop) {
        target = stop.pos;
      } else {
        target = nextTabStop(x);
      }

      if (target >= width) {
        flush();
        continue;
      }
      pieces.push({
        text: '',
        ...style,
        underline: false,
        strike: false,
        script: run.script,
        href: run.href,
        x,
        width: Math.max(0, target - x),
        rise,
      });
      x = target;
      continue;
    }

    if (/^[^\S\t\n]+$/.test(text)) {
      if (x > 0) {
        pieces.push({
          text,
          ...style,
          underline: !!run.underline,
          strike: !!run.strike,
          script: run.script,
          href: run.href,
          x,
          width: w,
          rise,
        });
        x += w;
      }
      continue;
    }

    if (x + w > width && x > 0) {
      while (pieces.length && /^ +$/.test(pieces[pieces.length - 1].text)) {
        const removed = pieces.pop()!;
        x -= removed.width;
      }
      flush();
    }

    pieces.push({
      text,
      ...style,
      underline: !!run.underline,
      strike: !!run.strike,
      script: run.script,
      href: run.href,
      x,
      width: w,
      rise,
    });
    x += w;
  }

  if (pieces.length) flush();
  return lines.filter((l, i) => l.pieces.length || (i > 0 && i < lines.length - 1));
}

/** Total width a line occupies, from its first piece to its last. */
export const lineWidth = (line: Line): number => {
  if (!line.pieces.length) return 0;
  const last = line.pieces[line.pieces.length - 1];
  return last.x + last.width;
};

/**
 * Shifts or stretches a line to satisfy `align`.
 *
 * Centre and right simply offset every piece. Justify distributes the slack
 * across the spaces, and deliberately skips the last line of a block — a
 * stretched final line is the classic sign of a naive justifier.
 */
export function alignLine(line: Line, align: Align, width: number, isLast: boolean): Line {
  const used = lineWidth(line);
  if (!line.pieces.length || used <= 0) return line;

  if (align === 'center' || align === 'right') {
    const slack = width - used;
    if (slack <= 0) return line;
    const shift = align === 'center' ? slack / 2 : slack;
    return { ...line, pieces: line.pieces.map((p) => ({ ...p, x: p.x + shift })) };
  }

  if (align === 'justify' && !isLast) {
    const gaps = line.pieces.filter((p) => /^ +$/.test(p.text));
    const slack = width - used;
    // Only close a genuine gap; stretching by a huge amount looks worse than
    // leaving the line ragged.
    if (!gaps.length || slack <= 0 || slack > width * 0.25) return line;
    const extra = slack / gaps.length;
    let shift = 0;
    return {
      ...line,
      pieces: line.pieces.map((p) => {
        const moved = { ...p, x: p.x + shift };
        if (/^ +$/.test(p.text)) {
          moved.width = p.width + extra;
          shift += extra;
        }
        return moved;
      }),
    };
  }

  return line;
}

/** Equal columns, which is predictable and never overflows the text area. */
export function columnWidths(columns: number, available: number, gap = 8): number[] {
  if (columns <= 0) return [];
  const each = (available - gap * (columns - 1)) / columns;
  return Array.from({ length: columns }, () => Math.max(24, each));
}

/** Total columns in a table, counting spans. */
export const tableColumns = (rows: Cell[][]): number =>
  Math.max(1, ...rows.map((row) => row.reduce((sum, c) => sum + Math.max(1, c.span), 0)));

/** Width of a cell that spans several columns, including the gaps it swallows. */
export const spanWidth = (widths: number[], start: number, span: number, gap = 8): number => {
  const taken = widths.slice(start, start + Math.max(1, span));
  return taken.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, taken.length - 1);
};

/**
 * Left edge of a column, measured from the start of the text area.
 *
 * Deliberately NOT spanWidth(widths, 0, start). That clamps the span to at
 * least one column, which is right for a cell's own width — every cell covers
 * at least one column — but wrong for an offset, where column 0 legitimately
 * begins at zero. The clamp gave the first cell of every row a full column of
 * offset, dropping it 8pt from the second cell so the two overlapped, and
 * pushing the whole table right by one column.
 */
export const columnOffset = (widths: number[], start: number, gap = 8): number => {
  const before = Math.max(0, start);
  return widths.slice(0, before).reduce((sum, w) => sum + w, 0) + gap * before;
};

/**
 * Flows blocks onto pages.
 *
 * Two rules make the output read like a document rather than a dump: a heading
 * is never left alone at the foot of a page, and a table row is never split
 * across a page break.
 */
export function layout(blocks: Block[], options: LayoutOptions): LaidOutPage[] {
  const { geometry, scale, measure } = options;

  // A multi-column section fills one column top to bottom, then the next, and
  // only then starts a page. Capped at 8 so a malformed w:num cannot slice the
  // page into unreadable slivers.
  const columnCount = Math.max(1, Math.min(Math.floor(options.columns ?? 1), 8));
  const columnGap = Math.max(0, options.columnGap ?? 0);
  const fullWidth = geometry.width - geometry.margin * 2;
  const textWidth = (fullWidth - columnGap * (columnCount - 1)) / columnCount;
  // Header and footer bands sit inside the margin, so the body has to start
  // lower and stop higher or it would print straight over them.
  const insetTop = Math.max(0, options.insetTop ?? 0);
  const insetBottom = Math.max(0, options.insetBottom ?? 0);
  const bottom = geometry.margin + insetBottom;
  const top = geometry.height - geometry.margin - insetTop;

  const pages: LaidOutPage[] = [];
  let items: Drawn[] = [];
  let column = 0;
  let y = top;
  /** Left edge of the column being filled; every x is measured from this. */
  let left = geometry.margin;

  // Everything downstream calls newPage() when it runs out of room, so making
  // it move to the next column first keeps column breaks and page breaks one
  // concept rather than two.
  const newPage = () => {
    if (column + 1 < columnCount) {
      column++;
      left = geometry.margin + column * (textWidth + columnGap);
      y = top;
      return;
    }
    pages.push({ items });
    items = [];
    column = 0;
    left = geometry.margin;
    y = top;
  };
  const room = (needed: number) => y - needed >= bottom;

  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'rule') {
      if (!room(14)) newPage();
      y -= 8;
      items.push({ kind: 'rule', x: left, y, width: textWidth });
      y -= 6;
      continue;
    }

    if (block.kind === 'image') {
      const cap = Math.min(options.maxImageWidth ?? textWidth, textWidth);

      // Word's own display size when the document declared one. Without it this
      // reserved the full text width at a hardcoded 4:3 ratio — about 425pt on
      // A4. Resume templates draw their section dividers as images 1pt tall, so
      // eight rules used to cost four entirely blank pages.
      let width: number;
      let height: number;
      if (block.width && block.height && block.width > 0 && block.height > 0) {
        // Only ever scaled DOWN: an icon must not be blown up to fill the column.
        const fit = Math.min(1, cap / block.width);
        width = block.width * fit;
        height = block.height * fit;
      } else {
        width = cap;
        height = width * 0.75;
      }

      // Padding proportional to the image rather than a flat 6pt each side. A
      // divider rule 1pt tall does not want 12pt of air around it: eight of them
      // cost 96pt, which was the last thing keeping a 2-page resume on 3 pages.
      const pad = Math.min(6, Math.max(1, height * 0.25));

      if (!room(height + pad * 2)) newPage();
      y -= pad;
      items.push({ kind: 'image', x: left, y: y - height, width, height, dataUri: block.dataUri });
      y -= height + pad;
      continue;
    }

    if (block.kind === 'table') {
      const padding = 4;
      const gap = 8;
      const rowCount = block.rows.length;

      /* --- place every cell on a grid --- */

      // A vertically merged cell keeps occupying its column in later rows, and
      // mammoth omits the continuation cells entirely. So the second row of a
      // vMerge has fewer <td>s, and without tracking occupancy its first cell
      // would be assigned column 0 and drawn underneath the spanning one.
      const occupied: boolean[][] = Array.from({ length: rowCount }, () => []);
      const placed: {
        cell: Cell;
        row: number;
        start: number;
        span: number;
        rowSpan: number;
        lines: Line[];
      }[] = [];
      let columns = 1;

      for (let r = 0; r < rowCount; r++) {
        let c = 0;
        for (const cell of block.rows[r]) {
          while (occupied[r][c]) c++;
          const span = Math.max(1, cell.span);
          // Clamped so a rowspan reaching past the last row cannot run away.
          const rowSpan = Math.min(Math.max(1, cell.rowSpan ?? 1), rowCount - r);
          placed.push({ cell, row: r, start: c, span, rowSpan, lines: [] });
          for (let rr = r; rr < r + rowSpan; rr++) {
            for (let cc = c; cc < c + span; cc++) occupied[rr][cc] = true;
          }
          c += span;
          columns = Math.max(columns, c);
        }
      }

      const widths = columnWidths(columns, textWidth);
      const cellLine = scale.body * scale.lineHeight;
      // A cell run may declare its own size now, so a line's advance follows its
      // tallest piece rather than the body size. Identical to cellLine for
      // ordinary cells.
      const advanceOf = (line: Line) => Math.max(cellLine, line.height * scale.lineHeight);
      const heightOf = (lines: Line[]) =>
        lines.reduce((total, line) => total + advanceOf(line), 0) + padding * 2;

      /* --- size the rows --- */

      const rowHeights = new Array<number>(rowCount).fill(cellLine + padding * 2);
      for (const item of placed) {
        const width = spanWidth(widths, item.start, item.span, gap);
        item.lines = wrapRuns(item.cell.runs, scale.body, width - padding * 2, measure);
        if (item.rowSpan === 1) {
          rowHeights[item.row] = Math.max(rowHeights[item.row], heightOf(item.lines));
        }
      }
      // A spanning cell taller than the rows it covers grows the last of them,
      // which is what keeps its text inside its own box.
      for (const item of placed) {
        if (item.rowSpan === 1) continue;
        const need = heightOf(item.lines);
        let have = 0;
        for (let rr = item.row; rr < item.row + item.rowSpan; rr++) have += rowHeights[rr];
        if (need > have) rowHeights[item.row + item.rowSpan - 1] += need - have;
      }

      /* --- paginate, keeping merged rows together --- */

      // Rows joined by a vertical merge cannot be split, or the cell box would
      // be drawn on one page and its lower half lost.
      const reach = Array.from({ length: rowCount }, (_, r) => r);
      for (const item of placed) {
        const last = item.row + item.rowSpan - 1;
        for (let rr = item.row; rr <= last; rr++) reach[rr] = Math.max(reach[rr], last);
      }

      let r = 0;
      while (r < rowCount) {
        let end = reach[r];
        for (let rr = r; rr <= end; rr++) end = Math.max(end, reach[rr]);

        let groupHeight = 0;
        for (let rr = r; rr <= end; rr++) groupHeight += rowHeights[rr];
        if (!room(groupHeight)) newPage();

        const top = y;
        const offset = new Array<number>(rowCount).fill(0);
        let acc = 0;
        for (let rr = r; rr <= end; rr++) {
          offset[rr] = acc;
          acc += rowHeights[rr];
        }

        for (const item of placed) {
          if (item.row < r || item.row > end) continue;
          const x = left + columnOffset(widths, item.start, gap);
          const width = spanWidth(widths, item.start, item.span, gap);
          let height = 0;
          for (let rr = item.row; rr < item.row + item.rowSpan; rr++) height += rowHeights[rr];

          const cellTop = top - offset[item.row];
          items.push({ kind: 'cellBox', x, y: cellTop - height, width, height });
          let ty = cellTop - padding - Math.max(scale.body, item.lines[0]?.height ?? 0);
          for (const line of item.lines) {
            items.push({ kind: 'line', x: x + padding, y: ty, line });
            ty -= advanceOf(line);
          }
        }

        y -= groupHeight;
        r = end + 1;
      }
      y -= 8;
      continue;
    }

    /* --- heading, paragraph, list item --- */

    const look = options.appearance?.(block) ?? {};

    // An explicit page break, before anything else is measured. Guarded on
    // items.length so a break on the very first block does not emit a blank
    // leading page.
    if (look.pageBreakBefore && items.length) newPage();

    const size = look.size ?? sizeFor(block, scale);

    // Word's "single" spacing is the font's own line height, not a round
    // number, and w:line is a multiple of that. Falling back to scale.lineHeight
    // only when the document says nothing keeps hand-built callers unchanged.
    const single = size * (scale.singleLine ?? 1.2207);
    const lineHeight =
      look.lineExact !== undefined
        ? look.lineAtLeast
          ? Math.max(look.lineExact, single)
          : look.lineExact
        : look.lineMultiple !== undefined
          ? single * look.lineMultiple
          : size * scale.lineHeight;

    const listIndent = block.kind === 'listItem' ? 18 * block.level : 0;
    const markerWidth = block.kind === 'listItem' ? 18 : 0;
    const indent = listIndent + Math.max(0, look.indent ?? 0);
    const firstLine = look.firstLine ?? 0;

    // A positive first-line indent narrows every line slightly rather than
    // letting the first one overflow the right margin; a hanging indent pulls
    // the first line left and leaves the width alone.
    const reserve = Math.max(0, firstLine);
    const available = textWidth - indent - markerWidth - reserve;

    // Word measures tab stops from the left margin, but wrapRuns works from the
    // block's own left edge, so shift them by the indent.
    const tabs = (look.tabs ?? [])
      .map((t) => ({ ...t, pos: t.pos - indent }))
      .filter((t) => t.pos > 0);

    const wrapped = wrapRuns(block.runs, size, available, measure, tabs);
    if (!wrapped.length) continue;

    const align: Align = look.align ?? 'left';
    const lines = wrapped.map((line, i) =>
      alignLine(line, align, available, i === wrapped.length - 1),
    );

    const previous = blocks[index - 1];
    const sameAsPrevious = previous !== undefined && previous.kind === block.kind;
    const defaultBefore = block.kind === 'heading' ? size * 0.85 : scale.body * 0.5;
    const spaceBefore =
      look.contextualSpacing && sameAsPrevious ? 0 : (look.spaceBefore ?? defaultBefore);
    const spaceAfter =
      look.contextualSpacing && blocks[index + 1]?.kind === block.kind
        ? 0
        : (look.spaceAfter ?? (block.kind === 'heading' ? size * 0.25 : 0));

    const needed =
      block.kind === 'heading'
        ? spaceBefore + lines.length * lineHeight + scale.body * scale.lineHeight
        : spaceBefore + lineHeight;

    if (!room(needed) && items.length) newPage();
    else y -= spaceBefore;

    for (const [i, line] of lines.entries()) {
      // A line holding a larger run needs proportionally more room, or it would
      // collide with the line above it.
      const tall = Math.max(size, line.height);
      const advance = size > 0 ? lineHeight * (tall / size) : lineHeight;

      if (!room(advance) && items.length) newPage();
      y -= tall;

      if (block.kind === 'listItem' && i === 0) {
        items.push({
          kind: 'line',
          x: left + indent,
          y,
          line: {
            size,
            height: size,
            pieces: [
              {
                text: block.marker,
                // Markers are bullets and Latin digits, so they are drawn with
                // the Latin face whatever script the item's text turns out to be.
                font: LATIN,
                bold: false,
                italic: false,
                underline: false,
                strike: false,
                size,
                x: 0,
                width: measure(block.marker, { bold: false, italic: false, size, font: LATIN }),
                rise: 0,
              },
            ],
          },
        });
      }

      // Only the first line takes the first-line offset.
      const offset = i === 0 ? firstLine : 0;
      items.push({
        kind: 'line',
        x: left + indent + markerWidth + reserve + offset,
        y,
        line,
      });
      y -= advance - tall;
    }

    if (blocks[index + 1]) y -= spaceAfter;
  }

  pages.push({ items });
  return pages.filter((p) => p.items.length);
}
