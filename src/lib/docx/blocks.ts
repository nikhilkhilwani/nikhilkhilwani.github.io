/**
 * Turns the HTML mammoth produces from a .docx into a flat block model.
 *
 * Hand-written rather than DOM-based on purpose: this must run identically in
 * the browser and in Node so scripts/test-pdf.mjs can verify the whole
 * .docx -> PDF pipeline in CI. It only has to understand the tags mammoth
 * actually emits, which is a small and stable set.
 *
 * What mammoth gives us was measured, not assumed:
 *   tabs        -> a literal \t character
 *   soft break  -> <br />
 *   super/sub   -> <sup> / <sub>
 *   links       -> <a href="…">
 *   nested list -> nested <ol> / <ul>, up to any depth
 *   merged cell -> colspan="n"   (vMerge/rowspan is NOT translated)
 *   page break  -> nothing at all, so it cannot be honoured here
 *
 * Pure. Covered by scripts/test-tools.mjs.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Raised or lowered, drawn smaller. */
  script?: 'super' | 'sub';
  /** Destination for a hyperlink run. */
  href?: string;
}

export interface Cell {
  runs: Run[];
  /** Columns this cell spans, from colspan. */
  span: number;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'listItem'; level: number; ordered: boolean; marker: string; runs: Run[] }
  | { kind: 'table'; rows: Cell[][] }
  | {
      kind: 'image';
      dataUri: string;
      /**
       * Display size in points, filled in later from the document's own
       * wp:extent. Absent means layout has to guess, which is what made a
       * 1pt divider rule reserve half a page.
       */
      width?: number;
      height?: number;
    }
  | { kind: 'rule' };

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // A normal space, not U+00A0: a non-breaking space inside a measured word
  // would defeat line breaking, and the layout pass collapses runs of
  // whitespace anyway.
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** Decodes the entities mammoth emits, plus numeric ones. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: string;
}

function parseTag(raw: string): Tag {
  const closing = raw.startsWith('</');
  const inner = raw.replace(/^<\/?/, '').replace(/\/?>$/, '');
  const space = inner.search(/\s/);
  return {
    name: (space === -1 ? inner : inner.slice(0, space)).toLowerCase(),
    closing,
    attrs: space === -1 ? '' : inner.slice(space),
  };
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
    ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  return m ? m[1] : undefined;
};

const sameStyle = (a: Run, b: Run): boolean =>
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  !!a.underline === !!b.underline &&
  !!a.strike === !!b.strike &&
  a.script === b.script &&
  a.href === b.href;

/**
 * Merges adjacent runs with identical styling and drops empty ones.
 *
 * Spaces collapse the way HTML rendering would, but TABS AND NEWLINES SURVIVE:
 * a tab positions text at a stop and a newline breaks the line, and collapsing
 * either into a single space is what made every tabbed CV line come out wrong.
 */
export function tidyRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else out.push({ ...run });
  }

  for (const run of out) {
    // Collapse only runs of plain spaces; leave \t and \n intact.
    run.text = run.text.replace(/[^\S\t\n]+/g, ' ');
  }
  if (out.length) {
    out[0].text = out[0].text.replace(/^ +/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '');
  }
  return out.filter((r) => r.text.length);
}

const HEADINGS: Record<string, 1 | 2 | 3> = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };

/**
 * Marker for an ordered list item at `depth`, matching Word's defaults:
 * 1. then a. then i., repeating for deeper levels.
 */
export function orderedMarker(depth: number, index: number): string {
  const style = (depth - 1) % 3;
  if (style === 0) return `${index}.`;
  if (style === 1) return `${letters(index)}.`;
  return `${roman(index)}.`;
}

/** 1 -> a, 26 -> z, 27 -> aa. */
export function letters(n: number): string {
  let out = '';
  let value = Math.max(1, n);
  while (value > 0) {
    const rem = (value - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

/** 1 -> i, 4 -> iv, 9 -> ix. */
export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let value = Math.max(1, n);
  let out = '';
  for (const [size, glyph] of table) {
    while (value >= size) {
      out += glyph;
      value -= size;
    }
  }
  return out;
}

/**
 * Bullet glyph by depth, cycling as Word does.
 *
 * Deliberately WinAnsi-safe: the obvious choices for levels 2 and 3 (◦ and ▪)
 * are outside what the built-in PDF fonts can encode, so they would be reported
 * as unsupported and drawn as "?". Word's own defaults are •, o and -.
 */
export const bulletMarker = (depth: number): string => ['•', 'o', '-'][(depth - 1) % 3];

/**
 * Parses mammoth's HTML into blocks.
 *
 * Unknown tags are transparent, and stray text still becomes a paragraph, so
 * nothing is ever silently dropped.
 */
export function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];

  // Inline styling state.
  let bold = 0;
  let italic = 0;
  let underline = 0;
  let strike = 0;
  const scripts: ('super' | 'sub')[] = [];
  const hrefs: string[] = [];
  const listStack: { ordered: boolean; count: number }[] = [];

  let runs: Run[] = [];
  let current: { kind: 'heading'; level: 1 | 2 | 3 } | { kind: 'paragraph' } | { kind: 'listItem' } | null = null;

  let table: Cell[][] | null = null;
  let row: Cell[] | null = null;
  let cell: Run[] | null = null;
  let cellSpan = 1;

  const pushText = (text: string) => {
    if (!text) return;
    const run: Run = { text: decodeEntities(text) };
    if (bold > 0) run.bold = true;
    if (italic > 0) run.italic = true;
    if (underline > 0) run.underline = true;
    if (strike > 0) run.strike = true;
    if (scripts.length) run.script = scripts[scripts.length - 1];
    // An entry can be '' for a link we cannot follow (an internal bookmark);
    // that must leave the run unlinked rather than carrying an empty target.
    const href = hrefs[hrefs.length - 1];
    if (href) run.href = href;
    if (cell) cell.push(run);
    else runs.push(run);
  };

  const flush = () => {
    const tidy = tidyRuns(runs);
    runs = [];

    // Text that never sat inside a <p> or heading still has to survive.
    if (!current) {
      if (tidy.length) blocks.push({ kind: 'paragraph', runs: tidy });
      return;
    }

    if (tidy.length) {
      if (current.kind === 'heading') {
        blocks.push({ kind: 'heading', level: current.level, runs: tidy });
      } else if (current.kind === 'listItem') {
        const depth = Math.max(1, listStack.length);
        const top = listStack[listStack.length - 1];
        blocks.push({
          kind: 'listItem',
          level: depth,
          ordered: !!top?.ordered,
          marker: top?.ordered ? orderedMarker(depth, top.count) : bulletMarker(depth),
          runs: tidy,
        });
      } else {
        blocks.push({ kind: 'paragraph', runs: tidy });
      }
    }
    current = null;
  };

  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token[0] !== '<') {
      pushText(token);
      continue;
    }

    const tag = parseTag(token);

    switch (tag.name) {
      case 'strong':
      case 'b':
        bold = Math.max(0, bold + (tag.closing ? -1 : 1));
        break;
      case 'em':
      case 'i':
        italic = Math.max(0, italic + (tag.closing ? -1 : 1));
        break;
      case 'u':
      case 'ins':
        underline = Math.max(0, underline + (tag.closing ? -1 : 1));
        break;
      case 's':
      case 'strike':
      case 'del':
        strike = Math.max(0, strike + (tag.closing ? -1 : 1));
        break;
      case 'sup':
        if (tag.closing) scripts.pop();
        else scripts.push('super');
        break;
      case 'sub':
        if (tag.closing) scripts.pop();
        else scripts.push('sub');
        break;

      case 'a': {
        if (tag.closing) {
          hrefs.pop();
        } else {
          const href = attr(tag.attrs, 'href');
          // Only real destinations; an internal bookmark cannot be followed
          // from a standalone PDF.
          if (href && /^(https?:|mailto:|tel:)/i.test(href)) hrefs.push(href);
          else hrefs.push('');
        }
        break;
      }

      case 'br':
        // A real line break, not a space. Word's soft break means "start a new
        // line here", and the layout pass honours \n.
        pushText('\n');
        break;

      case 'hr':
        flush();
        blocks.push({ kind: 'rule' });
        break;

      case 'img': {
        const src = attr(tag.attrs, 'src');
        if (src?.startsWith('data:image/')) blocks.push({ kind: 'image', dataUri: src });
        break;
      }

      case 'ul':
      case 'ol':
        // Flush first: a nested list opens while its parent <li> is still
        // pending, and changing the depth beforehand would file that item at
        // the child's level instead of its own.
        flush();
        if (tag.closing) listStack.pop();
        else listStack.push({ ordered: tag.name === 'ol', count: 0 });
        break;

      case 'li':
        flush();
        if (!tag.closing) {
          const top = listStack[listStack.length - 1];
          if (top) top.count += 1;
          current = { kind: 'listItem' };
        }
        break;

      case 'table':
        flush();
        if (tag.closing) {
          if (table && table.length) blocks.push({ kind: 'table', rows: table });
          table = null;
        } else {
          table = [];
        }
        break;

      case 'tr':
        if (tag.closing) {
          if (table && row) table.push(row);
          row = null;
        } else {
          row = [];
        }
        break;

      case 'td':
      case 'th':
        if (tag.closing) {
          if (row && cell) row.push({ runs: tidyRuns(cell), span: cellSpan });
          cell = null;
          cellSpan = 1;
        } else {
          cell = [];
          const span = Number(attr(tag.attrs, 'colspan') ?? '1');
          cellSpan = Number.isFinite(span) && span >= 1 ? Math.floor(span) : 1;
        }
        break;

      default: {
        const level = HEADINGS[tag.name];
        if (level) {
          flush();
          if (!tag.closing) current = { kind: 'heading', level };
        } else if (tag.name === 'p') {
          if (tag.closing) {
            if (!cell) flush();
          } else if (!cell) {
            flush();
            current = { kind: 'paragraph' };
          }
        }
        break;
      }
    }
  }

  flush();
  return blocks;
}

/**
 * Characters pdf-lib's built-in fonts cannot encode.
 *
 * The standard 14 fonts are WinAnsi only, which covers Latin-1 — so accented
 * European names are fine — but not CJK, Devanagari, Arabic and the like.
 * Those must be reported rather than dropped silently or allowed to throw
 * mid-render.
 */
/**
 * Characters the chosen font cannot draw, so the caller can warn instead of
 * shipping silent corruption.
 *
 * Pass `hasGlyph` when a real font is embedded and it is asked directly. With
 * no predicate this falls back to the WinAnsi set the built-in standard-14
 * fonts cover, which is the right answer only for that fallback path.
 */
export function unsupportedCharacters(
  blocks: Block[],
  hasGlyph?: (codePoint: number) => boolean,
): string[] {
  const found = new Set<string>();

  const scan = (text: string) => {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 9 || code === 10 || code === 13 || code === 32) continue;
      if (code < 0x20) continue;
      if (hasGlyph) {
        if (!hasGlyph(code)) found.add(ch);
        continue;
      }
      if (code <= 0xff) continue;
      if ('–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜'.includes(ch)) continue;
      found.add(ch);
    }
  };

  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const row of block.rows) for (const c of row) for (const run of c.runs) scan(run.text);
    } else if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') {
      for (const run of block.runs) scan(run.text);
      // The bullet glyphs beyond level 1 are outside WinAnsi.
      if (block.kind === 'listItem') scan(block.marker);
    }
  }
  return [...found];
}

/** Plain text of a block, for measuring and for tests. */
export const blockText = (block: Block): string => {
  if (block.kind === 'table') {
    return block.rows.map((r) => r.map((c) => c.runs.map((x) => x.text).join('')).join('\t')).join('\n');
  }
  if (block.kind === 'image' || block.kind === 'rule') return '';
  return block.runs.map((r) => r.text).join('');
};
