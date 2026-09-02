/**
 * Turning PDF drawing operations back into document structure.
 *
 * This is the whole difficulty of PDF-to-Word, isolated and made pure. A PDF
 * page holds no paragraphs, no headings, no lists and no tables — only "set
 * font Carlito-Bold at 15.5pt, move to (64, 678.9), show these glyphs". Every
 * structure Word needs has to be INFERRED from where the glyphs landed.
 *
 * Nothing here touches pdf.js. It takes positioned text and returns blocks, so
 * the inference can be tested against known geometry rather than by eye.
 *
 * The heuristics below were measured, not guessed. Running the repo's own
 * word-to-pdf over a document with known structure produced:
 *
 *   - body text at 11pt, headings at 15.5pt and 20pt
 *   - wrapped lines of one paragraph 15.2pt apart — 1.38x the font size
 *   - the gap to the NEXT paragraph 20.7pt — 1.88x
 *   - list items indented to x=82 with the bullet its own glyph run, and the
 *     text restarting at x=100, against a body margin of x=64
 *   - table cells sharing x positions 68 / 226.4 / 384.9 down three rows
 *
 * Those ratios are the thresholds. Coordinates are PDF user space: y counts
 * UPWARD from the bottom of the page, so reading order is descending y.
 */

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

/** One run of glyphs as the PDF drew it. */
export interface RawItem {
  text: string;
  /** Left edge, PDF user space. */
  x: number;
  /** Baseline, PDF user space — larger is higher up the page. */
  y: number;
  width: number;
  /** Point size, from the text matrix rather than any declared value. */
  size: number;
  /** The font's real name when it could be resolved, else its internal id. */
  font: string;
  /** pdf.js marks the end of a drawn line. */
  eol: boolean;
}

export interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  size: number;
  /** The typeface family, without its weight or slope. Optional so that spans
   *  synthesised by callers need not invent one. */
  family?: string;
  /** Left edge in PDF user space. Table columns are recovered from this, so it
   *  is measured rather than estimated from character counts. */
  x: number;
  width: number;
}

export interface Line {
  spans: Span[];
  /** Leftmost glyph edge. */
  x: number;
  /** Rightmost glyph edge. */
  right: number;
  y: number;
  /** The size most of the line's characters were set in. */
  size: number;
}

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table';

export interface Block {
  kind: BlockKind;
  /** 1-3 for headings. */
  level?: number;
  /** Nesting depth of a list item, 0 for the outermost. */
  depth?: number;
  /** For list items. */
  marker?: 'bullet' | 'number';
  /** Content of a heading, paragraph or list item. */
  spans?: Span[];
  /** Table content: rows of cells of spans. */
  rows?: Span[][][];
  /** How far the block is indented from the body margin, in points. */
  indent?: number;
}

/* -------------------------------------------------------------------------- */
/* Font names                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Weight and slope have to come from the font's NAME.
 *
 * pdf.js exposes ascent, descent and a generic fontFamily ("sans-serif") in
 * `content.styles`, and its font objects leave `.bold` and `.italic` undefined.
 * The name is the only thing that distinguishes Carlito-Bold from
 * Carlito-Regular, which is why the caller goes to the trouble of resolving it.
 *
 * Subset prefixes ("ABCDEF+") and pdf.js's uniquifying suffixes ("-8774") are
 * both stripped, and 'Oblique' counts as italic.
 */
export function styleOf(fontName: string): { bold: boolean; italic: boolean; mono: boolean } {
  const name = fontName.replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, '');
  const lower = name.toLowerCase();
  return {
    // 'Semibold' and 'Black' both read as bold in Word, which has one flag.
    bold: /bold|black|heavy|semibold|demi/.test(lower),
    italic: /italic|oblique/.test(lower),
    mono: /mono|courier|consol|menlo/.test(lower),
  };
}

/** Words in a font name that describe the weight or slope, not the family. */
const FACE_WORDS =
  /^(regular|book|roman|italic|oblique|bold|black|heavy|semibold|demibold|demi|light|thin|extralight|ultralight|medium|condensed|narrow|expanded|mt|ps|psmt|it|ital|bd|bi|blk|rg|obl)$/i;

/**
 * The base-14 PDF fonts, mapped to families a reader actually has.
 *
 * "Helvetica" and "Times" are PostScript names present on almost no Windows
 * machine; Arial and Times New Roman are their metric-compatible equivalents,
 * which is the substitution Word and LibreOffice both make anyway. Naming them
 * outright means the document looks as intended instead of depending on
 * whatever fallback the reader happens to choose.
 */
const FAMILY_ALIASES: Record<string, string> = {
  helvetica: 'Arial',
  arial: 'Arial',
  times: 'Times New Roman',
  timesnewroman: 'Times New Roman',
  courier: 'Courier New',
  couriernew: 'Courier New',
  symbol: 'Symbol',
  zapfdingbats: 'Wingdings',
};

/** Face descriptions glued onto a family with no separator. */
const GLUED_FACE =
  /^(.+?)(BoldItalic|BoldOblique|Regular|Italic|Oblique|Bold|Black|Heavy|SemiBold|DemiBold|Light|Thin|Medium|PSMT|MT|PS)$/;

/**
 * The typeface family behind a PDF font name.
 *
 * Without this, every converted document came out in a single font whatever the
 * PDF used: the weight was read off the name and the family then discarded.
 *
 * Names arrive in several shapes and often several at once — a subset prefix
 * ("ABCDEF+"), pdf.js's uniquifying suffix ("-8774"), and the face description
 * attached with a hyphen ("Carlito-Bold"), a comma ("Arial,Bold") or nothing at
 * all ("TimesNewRomanPSMT").
 */
export function familyOf(fontName: string): string {
  let name = fontName.replace(/^[A-Z]{6}\+/, '').replace(/-\d+$/, '').split(',')[0];

  // Peel face words off the end until nothing more comes away. The loop stops
  // because every branch shortens the name.
  for (let guard = 0; guard < 8; guard++) {
    const before = name;
    name = name.replace(/[-_ ]+$/, '');

    const parts = name.split(/[-_ ]/);
    if (parts.length > 1 && FACE_WORDS.test(parts[parts.length - 1])) {
      name = parts.slice(0, -1).join('-');
    } else {
      const glued = GLUED_FACE.exec(name);
      // Keep at least three characters, so "MT" alone does not eat the name.
      if (glued && glued[1].length >= 3) name = glued[1];
    }

    if (name === before) break;
  }

  // The alias table covers the run-together PostScript names that matter --
  // "TimesNewRomanPSMT" and the rest -- so no attempt is made to split
  // camelCase generally. Guessing a word boundary turns "JetBrainsMono", which
  // a reader may have installed, into "Jet Brains Mono", which nobody has.
  const alias = FAMILY_ALIASES[name.replace(/[-_ ]/g, '').toLowerCase()];
  if (alias) return alias;

  return name.replace(/[-_]+/g, ' ').trim() || fontName;
}

/* -------------------------------------------------------------------------- */
/* Items to lines                                                             */
/* -------------------------------------------------------------------------- */

/** Baselines this close together belong to the same line. */
const BASELINE_TOLERANCE = 0.35;
/** A horizontal gap this wide, relative to size, reads as a word space. */
const SPACE_RATIO = 0.22;
/**
 * Whitespace wider than this, relative to the font size, is not a word space —
 * it is the pen jumping somewhere. Keeping such runs as their own spans is what
 * makes list markers and table columns recoverable at all: merge them into
 * their neighbours and "• First point" becomes one indivisible string, and a
 * table row becomes a sentence.
 */
const GAP_RATIO = 0.8;
/**
 * How wide a gap must be, relative to the font size, to be a TABLE COLUMN.
 *
 * Splitting a span at 0.8x is cheap and reversible — prose puts the pieces back
 * together with a single space and nothing is lost. Declaring a column is a
 * structural claim, and it needs much stronger evidence, because justified text
 * stretches its spaces to reach both margins and those stretched spaces look
 * exactly like small column gaps.
 *
 * Measured: the repo's own justifier, given deliberately long words, produced
 * spaces of 2.14x the font size, and it permits slack up to a quarter of the
 * line width, so worse is possible. A real table's gaps were 11.6x. The two
 * populations are far apart; the old single threshold sat in the wrong one and
 * read justified paragraphs as two-column tables.
 */
const CELL_GAP_RATIO = 2.5;

const sameStyle = (a: Span, b: Span) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.mono === b.mono &&
  // Two families must not fuse into one run, or the second loses its typeface.
  a.family === b.family &&
  Math.abs(a.size - b.size) < 0.6;

/** A span that exists only to move across the page. */
export const isGap = (span: Span): boolean =>
  /^\s+$/.test(span.text) && span.width > span.size * GAP_RATIO;

/** The size most of a run of spans was set in, weighted by character count. */
function dominantSize(spans: Span[]): number {
  const weight = new Map<number, number>();
  for (const span of spans) {
    const key = Math.round(span.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + Math.max(1, span.text.trim().length));
  }
  let best = spans[0]?.size ?? 11;
  let most = -1;
  for (const [size, count] of weight) {
    if (count > most) {
      most = count;
      best = size;
    }
  }
  return best;
}

/**
 * Groups positioned glyph runs into lines.
 *
 * Two things make this more than a sort. A PDF may draw a line as a dozen runs
 * with no spaces between them, so a space has to be reconstructed from the gap
 * between one run's right edge and the next run's left. And it may equally draw
 * an explicit space run of enormous width to jump between table columns — which
 * must NOT collapse into a single space, or the columns run together.
 */
export function toLines(items: RawItem[]): Line[] {
  const real = items.filter((item) => item.text.length > 0);
  if (!real.length) return [];

  // Reading order: down the page, then across.
  const sorted = [...real].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const groups: RawItem[][] = [];
  for (const item of sorted) {
    const current = groups[groups.length - 1];
    const last = current?.[current.length - 1];
    const tolerance = Math.max(1, (last?.size ?? item.size) * BASELINE_TOLERANCE);
    if (last && Math.abs(last.y - item.y) <= tolerance) current.push(item);
    else groups.push([item]);
  }

  const lines: Line[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x - b.x);
    const spans: Span[] = [];
    let cursor = group[0].x;

    for (const item of group) {
      const style = styleOf(item.font);
      const gap = item.x - cursor;

      // A gap the PDF left empty still separates words -- but a WIDE one is a
      // jump, and becomes its own span rather than a space inside a neighbour.
      if (spans.length && gap > item.size * SPACE_RATIO) {
        if (gap > item.size * GAP_RATIO) {
          spans.push({
            text: ' ', bold: false, italic: false, mono: false,
            size: item.size, x: cursor, width: gap,
          });
        } else {
          const tail = spans[spans.length - 1];
          if (!/\s$/.test(tail.text)) tail.text += ' ';
        }
      }

      const span: Span = {
        text: item.text,
        bold: style.bold,
        italic: style.italic,
        mono: style.mono,
        size: item.size,
        x: item.x,
        width: item.width,
        family: familyOf(item.font),
      };

      const tail = spans[spans.length - 1];
      // Never merge across a jump, in either direction.
      if (tail && sameStyle(tail, span) && !isGap(tail) && !isGap(span)) {
        tail.text += span.text;
        tail.width = item.x + item.width - tail.x;
      } else {
        spans.push(span);
      }

      cursor = item.x + item.width;
    }

    // Squeeze runs of ordinary whitespace, leaving the jumps alone.
    for (const span of spans) {
      if (!isGap(span)) span.text = span.text.replace(/\s{2,}/g, ' ');
    }
    const inner = spans.filter((span) => span.text.length > 0);
    if (!inner.length) continue;
    // Trim the ends of the line, including a leading or trailing jump.
    while (inner.length && (isGap(inner[0]) || !inner[0].text.trim())) inner.shift();
    while (inner.length && (isGap(inner[inner.length - 1]) || !inner[inner.length - 1].text.trim())) {
      inner.pop();
    }
    if (!inner.length) continue;
    inner[0].text = inner[0].text.replace(/^\s+/, '');
    inner[inner.length - 1].text = inner[inner.length - 1].text.replace(/\s+$/, '');
    const kept = inner.filter((span) => span.text.length > 0);
    if (!kept.length) continue;

    lines.push({
      spans: kept,
      x: group[0].x,
      right: Math.max(...group.map((item) => item.x + item.width)),
      y: group[0].y,
      size: dominantSize(kept),
    });
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Lines to blocks                                                            */
/* -------------------------------------------------------------------------- */

export const lineText = (line: Line): string =>
  proseSpans(line.spans).map((span) => span.text).join('');

/**
 * Collapses jump spans back into single spaces.
 *
 * A jump is meaningful to table detection and meaningless to prose, so it is
 * preserved on the Line and removed here, at the point where a paragraph, a
 * heading or a list item is finally emitted.
 */
export function proseSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (isGap(span)) {
      const tail = out[out.length - 1];
      if (tail && !/\s$/.test(tail.text)) tail.text += ' ';
      continue;
    }
    const tail = out[out.length - 1];
    if (tail && sameStyle(tail, span)) tail.text += span.text;
    else out.push({ ...span });
  }
  if (out.length) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  return tidyEmphasis(out.filter((span) => span.text.length > 0));
}

/**
 * Moves whitespace out of emphasised runs.
 *
 * A PDF draws the space after a bold word in the bold font, so the run comes
 * back as "bold " and is written out as <strong>bold </strong>. Word normalises
 * this itself, and leaving it produces emphasis on the space — invisible, but
 * it survives every later edit and shows up the moment someone turns on
 * formatting marks.
 */
export function tidyEmphasis(spans: Span[]): Span[] {
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (!span.bold && !span.italic) continue;

    const leading = /^\s+/.exec(span.text);
    if (leading && span.text.trim()) {
      span.text = span.text.slice(leading[0].length);
      const previous = spans[i - 1];
      if (previous && !/\s$/.test(previous.text)) previous.text += leading[0];
    }

    const trailing = /\s+$/.exec(span.text);
    if (trailing && span.text.trim()) {
      span.text = span.text.slice(0, span.text.length - trailing[0].length);
      const next = spans[i + 1];
      if (next && !/^\s/.test(next.text)) next.text = trailing[0] + next.text;
      else if (!next) span.text += trailing[0];
    }
  }
  return spans.filter((span) => span.text.length > 0);
}

/** The size most of the page's text is set in — the baseline for "is a heading". */
export function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + lineText(line).trim().length);
  }
  let best = 11;
  let most = -1;
  for (const [size, count] of weight) {
    if (count > most) {
      most = count;
      best = size;
    }
  }
  return best;
}

/** The left margin most lines start at. */
export function bodyMargin(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.x);
    weight.set(key, (weight.get(key) ?? 0) + 1);
  }
  let best = lines[0]?.x ?? 0;
  let most = -1;
  for (const [x, count] of weight) {
    if (count > most || (count === most && x < best)) {
      most = count;
      best = x;
    }
  }
  return best;
}

/** A leading glyph run that is a list marker rather than a word. */
const BULLET = /^[•▪◦·‣⁃∙●○−–-]$/;
const NUMBER = /^\(?(?:\d{1,3}|[ivxlcdm]{1,6}|[a-z])[.)]$/i;

export function markerOf(text: string): 'bullet' | 'number' | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (BULLET.test(trimmed)) return 'bullet';
  if (NUMBER.test(trimmed)) return 'number';
  return null;
}

/** Whether a line opens with something that reads as a list marker. */
export function isListLine(line: Line): boolean {
  const first = line.spans[0];
  if (!first) return false;
  if (markerOf(first.text) === null) return false;
  // The marker has to stand alone, followed by a jump to the text.
  const rest = line.spans.slice(1);
  if (!rest.length) return false;
  const next = rest.find((span) => !isGap(span));
  if (!next) return false;
  return next.x - (first.x + first.width) > first.size * SPACE_RATIO;
}

interface ListShape {
  marker: 'bullet' | 'number';
  /** Where the text after the marker begins. */
  textX: number;
  spans: Span[];
}

/**
 * Splits a line into its list marker and the rest, when it has one.
 *
 * The marker has to be its own glyph run AND be followed by a real horizontal
 * jump. Without the second test, a paragraph opening "1996 was the year..."
 * would be read as item 1 of a numbered list.
 */
function listShape(line: Line): ListShape | null {
  const first = line.spans[0];
  if (!first) return null;
  const marker = markerOf(first.text);
  if (!marker) return null;

  const rest = proseSpans(line.spans.slice(1));
  if (!rest.length) return null;
  const text = rest.map((span) => span.text).join('').trim();
  if (!text) return null;

  // The marker must be followed by a real horizontal jump. Without this test a
  // paragraph opening "1. " is indistinguishable from one opening "1996 was" --
  // and worse, an ordinary sentence beginning with a dash becomes a bullet.
  const jumped = rest[0].x - (first.x + first.width) > first.size * SPACE_RATIO;
  if (!jumped) return null;

  return { marker, textX: rest[0].x, spans: rest };
}

/** Lines whose columns line up are a table, not three coincidences. */
const COLUMN_TOLERANCE = 3;

interface ColumnRun {
  from: number;
  to: number;
  columns: number[];
  /** Indices of lines that continue the row above rather than starting one. */
  continuations: number[];
}

/**
 * Finds runs of consecutive lines that share column positions.
 *
 * Column starts come from the gaps WITHIN a line: a horizontal jump much wider
 * than a word space is a move to the next cell. Two or more consecutive lines
 * agreeing on two or more such positions is a table; anything less is prose
 * that happened to have a wide gap in it.
 */
export function findTableRuns(lines: Line[]): ColumnRun[] {
  // A list item is bullet, jump, text -- which is indistinguishable from a
  // two-column row, and four of them in a row are indistinguishable from a
  // table. Lists are the commoner shape and the more useful reading, so they
  // are taken out of the running before columns are looked for at all.
  const starts = lines.map((line) => (isListLine(line) ? [] : cellStarts(line)));

  const runs: ColumnRun[] = [];
  let i = 0;
  while (i < lines.length) {
    if (starts[i].length < 2) {
      i++;
      continue;
    }
    let j = i + 1;
    let shared = starts[i];
    const continuations: number[] = [];

    while (j < lines.length) {
      if (starts[j].length >= 2) {
        const next = intersect(shared, starts[j]);
        if (next.length < 2) break;
        shared = next;
        j++;
        continue;
      }
      // A cell whose text wrapped puts content in ONE column, which used to
      // end the run and turn the rest of the table into paragraphs. Absorbing
      // it keeps the table whole; toBlocks then folds it into the row above
      // instead of inventing a row for it.
      if (continuesRow(lines[j], lines[j - 1], shared)) {
        continuations.push(j);
        j++;
        continue;
      }
      break;
    }

    // How much agreement is enough.
    //
    // cellStarts always reports the line's own left edge, so "two shared
    // columns" only ever meant ONE agreeing interior gap — far too little. A
    // table with three or more columns is convincing on two rows; a
    // two-column one has a single interior gap to go on, and needs three rows
    // before it is more likely a table than a coincidence.
    const rows = j - i - continuations.length;
    const enough = shared.length >= 3 ? rows >= 2 : rows >= 3;
    if (enough && rows >= 2) {
      runs.push({ from: i, to: j - 1, columns: shared, continuations });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

/** Whether a line carries the overflow of the row above it. */
function continuesRow(line: Line, previous: Line, columns: number[]): boolean {
  if (isListLine(line)) return false;
  const gap = previous.y - line.y;
  // Wrap spacing, not paragraph spacing.
  if (gap <= 0 || gap > line.size * WRAP_LEADING) return false;
  // And it must begin at one of the table's own columns.
  return columns.some((column) => Math.abs(line.x - column) <= COLUMN_TOLERANCE);
}

/**
 * Where each cell of a would-be table row begins.
 *
 * A cell boundary is the left edge of the span that FOLLOWS a jump — measured
 * from the PDF, not estimated, because a column position guessed from character
 * counts drifts by whole characters and then no two rows agree.
 */
export function cellStarts(line: Line): number[] {
  const starts = [line.x];
  for (let i = 0; i < line.spans.length; i++) {
    const span = line.spans[i];
    // A stretched word space is a gap, but not a column.
    if (!isGap(span) || span.width < span.size * CELL_GAP_RATIO) continue;
    const next = line.spans[i + 1];
    if (next && !isGap(next)) starts.push(next.x);
  }
  return starts;
}

function intersect(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (const value of a) {
    if (b.some((other) => Math.abs(other - value) <= COLUMN_TOLERANCE)) out.push(value);
  }
  return out;
}

/** Splits a line into cells at the given column positions. */
function splitAtColumns(line: Line, columns: number[]): Span[][] {
  const cells: Span[][] = columns.map(() => []);
  for (const span of line.spans) {
    if (isGap(span)) continue;
    // The last column whose start this span reaches.
    let index = 0;
    for (let c = 0; c < columns.length; c++) {
      if (span.x + COLUMN_TOLERANCE >= columns[c]) index = c;
    }
    cells[index].push({ ...span });
  }
  return cells.map((cell) => proseSpans(cell));
}

/** Folds a continuation line's cells into the row it belongs to. */
function mergeCells(row: Span[][], extra: Span[][]): void {
  for (let column = 0; column < extra.length; column++) {
    const addition = extra[column];
    if (!addition?.length) continue;
    const cell = (row[column] ??= []);
    const tail = cell[cell.length - 1];
    if (tail && !/\s$/.test(tail.text)) tail.text += ' ';
    for (const span of addition) cell.push({ ...span });
    row[column] = proseSpans(cell);
  }
}

export interface BlockOptions {
  /** Overrides the measured body size, for testing. */
  bodySize?: number;
  /** Overrides the measured left margin. */
  margin?: number;
}

/**
 * Groups lines into blocks: headings, paragraphs, list items and tables.
 *
 * The hardest judgement is which line breaks the author meant. A wrapped line
 * and a new paragraph look identical in a PDF; what separates them is the
 * vertical gap and whether the previous line ran to the right margin.
 */
export function toBlocks(lines: Line[], options: BlockOptions = {}): Block[] {
  if (!lines.length) return [];

  const body = options.bodySize ?? bodySize(lines);
  const margin = options.margin ?? bodyMargin(lines);
  // The widest any line reached, which stands in for the text column's width.
  const rightEdge = Math.max(...lines.map((line) => line.right));

  const tableRuns = findTableRuns(lines);
  const inTable = new Map<number, ColumnRun>();
  for (const run of tableRuns) {
    for (let i = run.from; i <= run.to; i++) inTable.set(i, run);
  }

  const blocks: Block[] = [];
  let open: { block: Block; line: Line } | null = null;

  const close = () => {
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const run = inTable.get(i);
    if (run && run.from === i) {
      close();
      const rows: Span[][][] = [];
      for (let r = run.from; r <= run.to; r++) {
        const cells = splitAtColumns(lines[r], run.columns);
        if (run.continuations.includes(r) && rows.length) {
          mergeCells(rows[rows.length - 1], cells);
        } else {
          rows.push(cells);
        }
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }
    if (run) continue; // consumed by the table above

    const line = lines[i];
    const text = lineText(line).trim();
    if (!text) {
      close();
      continue;
    }

    const heading = headingLevel(line, body);
    const list = listShape(line);

    if (heading) {
      close();
      blocks.push({ kind: 'heading', level: heading, spans: proseSpans(line.spans) });
      continue;
    }

    if (list) {
      close();
      const block: Block = {
        kind: 'list',
        marker: list.marker,
        spans: list.spans,
        indent: Math.max(0, Math.round(line.x - margin)),
      };
      blocks.push(block);
      open = { block, line };
      continue;
    }

    // Does this line continue the block above it?
    if (open && continues(open.line, line, body, rightEdge)) {
      const spans = open.block.spans!;
      const tail = spans[spans.length - 1];
      // A hyphen at a line break is the word, not punctuation.
      if (tail && /­$/.test(tail.text)) tail.text = tail.text.replace(/­$/, '');
      else if (tail && !/\s$/.test(tail.text)) tail.text += ' ';
      for (const span of proseSpans(line.spans)) {
        const last = spans[spans.length - 1];
        if (last && sameStyle(last, span)) last.text += span.text;
        else spans.push({ ...span });
      }
      open.line = line;
      continue;
    }

    const block: Block = {
      kind: 'paragraph',
      spans: proseSpans(line.spans),
      indent: Math.max(0, Math.round(line.x - margin)),
    };
    blocks.push(block);
    open = { block, line };
  }

  // Depths can only be assigned once every list item is known.
  assignListDepths(blocks);
  return blocks;
}

/** Indents closer together than this are the same nesting level. */
const TIER_TOLERANCE = 6;
/** The numbering definitions written by the .docx writer go three deep. */
const MAX_DEPTH = 2;

/**
 * Turns list indents into nesting levels.
 *
 * A depth means nothing on its own: 36pt is the outer level in one document and
 * the second level in another. So the distinct indents actually used are
 * collected, sorted and banded, and a level is a position in that list rather
 * than a comparison against any fixed measurement.
 */
export function assignListDepths(blocks: Block[]): void {
  const indents = blocks
    .filter((block) => block.kind === 'list')
    .map((block) => block.indent ?? 0);
  if (!indents.length) return;

  const tiers: number[] = [];
  for (const indent of [...indents].sort((a, b) => a - b)) {
    if (!tiers.length || indent - tiers[tiers.length - 1] > TIER_TOLERANCE) tiers.push(indent);
  }

  for (const block of blocks) {
    if (block.kind !== 'list') continue;
    const indent = block.indent ?? 0;
    let depth = 0;
    for (let i = 0; i < tiers.length; i++) {
      if (indent >= tiers[i] - TIER_TOLERANCE) depth = i;
    }
    block.depth = Math.min(depth, MAX_DEPTH);
  }
}

/** How many times bigger than body text a line has to be to be a heading. */
const HEADING_RATIO = 1.12;

function headingLevel(line: Line, body: number): number | null {
  const text = lineText(line).trim();
  if (!text) return null;
  const ratio = line.size / body;

  if (ratio >= HEADING_RATIO) {
    if (ratio >= 1.6) return 1;
    if (ratio >= 1.3) return 2;
    return 3;
  }

  // Same size but wholly bold and short: the other common way to write a
  // heading. A long bold line is emphasis, not a heading.
  const allBold = line.spans.every((span) => span.bold || !span.text.trim());
  if (allBold && text.length <= 60 && !/[.;:]$/.test(text)) return 3;

  return null;
}

/** Line spacing under this multiple of the font size is a wrap, not a break. */
const WRAP_LEADING = 1.6;
/** A line ending this far short of the column edge finished its paragraph. */
const SHORT_LINE = 0.82;

function continues(previous: Line, line: Line, body: number, rightEdge: number): boolean {
  // A new size means a new block whatever the spacing says.
  if (Math.abs(previous.size - line.size) > 0.6) return false;

  const gap = previous.y - line.y;
  if (gap <= 0) return false;
  if (gap > line.size * WRAP_LEADING) return false;

  // An indent change marks a new paragraph even at wrap spacing.
  if (Math.abs(previous.x - line.x) > body * 0.75) return false;

  // The decisive test: a paragraph's non-final lines reach the column edge.
  // One that stops well short of it had finished what it was saying.
  const columnWidth = rightEdge - previous.x;
  if (columnWidth > 0 && (previous.right - previous.x) / columnWidth < SHORT_LINE) return false;

  return true;
}

/* -------------------------------------------------------------------------- */
/* Page furniture                                                             */
/* -------------------------------------------------------------------------- */

/** How much of the top and bottom of a page can hold furniture. */
const FURNITURE_ZONE = 0.12;
/** Furniture has to repeat on at least this share of the pages. */
const FURNITURE_SHARE = 0.6;
/**
 * The widest a furniture line may be, as a share of the widest line on its
 * page.
 *
 * This is what stops the digit-blanking below from eating the document. A
 * running footer reads "Page 3 of 12" and has to match "Page 4 of 12", so the
 * numbers are blanked before the texts are compared — which also makes
 * "Paragraph 1 of the body..." and "Paragraph 12 of the body..." identical. A
 * wrapped body line runs to the right margin; a running header is a short
 * label. Measured on a real conversion: header 29% of the column, footer 23%,
 * body lines 98%.
 */
const FURNITURE_WIDTH = 0.7;
/** Furniture sits at the same height on every page; body text does not. */
const FURNITURE_DRIFT = 2.5;

export interface PageLines {
  lines: Line[];
  /** Page height in points, so the top and bottom zones can be measured. */
  height: number;
}

/**
 * A line's text with its numbers blanked, so that "Page 3 of 12" and
 * "Page 4 of 12" count as the same running footer.
 */
function furnitureKey(line: Line): string {
  return lineText(line)
    .trim()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Marks the lines that are page furniture rather than content.
 *
 * A running header or footer is drawn on every page, and a converter that
 * treats it as body text produces a document with "Confidential — Page 3 of
 * 12" wedged between paragraphs a dozen times over. Nothing in the PDF says
 * which lines those are; what gives them away is that the same text keeps
 * appearing in the same band at the top or bottom of the page.
 *
 * Repetition is the whole test, so a single-page document never loses
 * anything: the threshold below is at least two pages, and one page cannot
 * reach it. That is deliberately the only thing protecting it — an extra
 * length guard here would be unreachable, and unreachable defence reads as
 * though it were doing something.
 */
export function furnitureFlags(pages: PageLines[]): boolean[][] {
  const none = () => pages.map((page) => page.lines.map(() => false));

  const zoneOf = (line: Line, height: number): string | null => {
    if (height <= 0) return null;
    if (line.y > height * (1 - FURNITURE_ZONE)) return 'top';
    if (line.y < height * FURNITURE_ZONE) return 'bottom';
    return null;
  };

  // A line is only a candidate if it is short for its page. Widths are
  // compared against the widest line actually present rather than the page
  // size, because the text column may be much narrower than the paper.
  const widest = pages.map((page) =>
    page.lines.reduce((most, line) => Math.max(most, line.right - line.x), 0),
  );

  const candidateKey = (line: Line, page: PageLines, index: number): string | null => {
    const zone = zoneOf(line, page.height);
    if (!zone) return null;
    const column = widest[index];
    if (column > 0 && (line.right - line.x) / column > FURNITURE_WIDTH) return null;
    const text = furnitureKey(line);
    return text ? zone + '|' + text : null;
  };

  const seen = new Map<string, { pages: Set<number>; heights: number[] }>();
  pages.forEach((page, index) => {
    for (const line of page.lines) {
      const key = candidateKey(line, page, index);
      if (!key) continue;
      const entry = seen.get(key) ?? { pages: new Set<number>(), heights: [] };
      entry.pages.add(index);
      entry.heights.push(line.y);
      seen.set(key, entry);
    }
  });

  const threshold = Math.max(2, Math.ceil(pages.length * FURNITURE_SHARE));
  const furniture = new Set<string>();
  for (const [key, entry] of seen) {
    if (entry.pages.size < threshold) continue;
    // And it has to sit at the same height each time. Body text that repeats
    // by coincidence drifts down the page; a header does not move.
    const lowest = Math.min(...entry.heights);
    const highest = Math.max(...entry.heights);
    if (highest - lowest > FURNITURE_DRIFT) continue;
    furniture.add(key);
  }
  if (!furniture.size) return none();

  return pages.map((page, index) =>
    page.lines.map((line) => {
      const key = candidateKey(line, page, index);
      return key ? furniture.has(key) : false;
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Honesty checks                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A page with no text at all is a scan — a photograph of a document. Reading it
 * needs OCR, which this tool does not do, and silently producing an empty Word
 * file would be the worst possible outcome.
 */
export function looksScanned(items: RawItem[], imageCount: number): boolean {
  const characters = items.reduce((sum, item) => sum + item.text.trim().length, 0);
  return characters < 12 && imageCount > 0;
}

/**
 * Glyphs with no usable Unicode mapping come back as private-use characters or
 * as runs of the replacement character. The text is then unrecoverable and the
 * output would be convincing-looking nonsense.
 */
export function unmappedRatio(items: RawItem[]): number {
  let total = 0;
  let bad = 0;
  for (const item of items) {
    for (const character of item.text) {
      const code = character.codePointAt(0)!;
      if (character === ' ' || character === '\n') continue;
      total++;
      // Private use areas, the replacement character, and unassigned controls.
      if (
        character === '�' ||
        (code >= 0xe000 && code <= 0xf8ff) ||
        (code >= 0xf0000 && code <= 0xffffd) ||
        (code < 0x20 && code !== 9)
      ) {
        bad++;
      }
    }
  }
  return total ? bad / total : 0;
}

/**
 * Detects side-by-side columns, which this tool reads straight down and would
 * therefore interleave. Reporting it beats silently scrambling the text.
 */
export function looksMultiColumn(lines: Line[], pageWidth: number): boolean {
  if (lines.length < 6) return false;
  const mid = pageWidth / 2;

  // Case one: the columns have their own baselines, so each line belongs
  // wholly to the left or wholly to the right.
  let left = 0;
  let right = 0;
  for (const line of lines) {
    if (line.right < mid) left++;
    else if (line.x > mid) right++;
  }
  const crossing = lines.length - left - right;
  if (lines.length >= 12 && left >= 4 && right >= 4 && crossing < lines.length * 0.25) {
    return true;
  }

  // Case two, and the more dangerous one: the columns share baselines, so the
  // line grouping has already interleaved them. "Left column text" and "right
  // column text" become one line with a jump across the middle of the page —
  // which reads as a sentence and is silently wrong. A gap straddling the
  // centre on line after line is the signature.
  let straddling = 0;
  for (const line of lines) {
    const spans = line.spans;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!isGap(span)) continue;
      if (span.x < mid && span.x + span.width > mid) {
        straddling++;
        break;
      }
    }
  }
  return straddling >= 4 && straddling >= lines.length * 0.5;
}
