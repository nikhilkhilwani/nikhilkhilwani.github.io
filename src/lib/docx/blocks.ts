/**
 * Turns the HTML mammoth produces from a .docx into a flat block model.
 *
 * Hand-written rather than DOM-based on purpose: this must run identically in
 * the browser and in Node so scripts/test-pdf.mjs can verify the whole
 * .docx -> PDF pipeline in CI. It only has to understand the tags mammoth
 * actually emits, which is a small and stable set.
 *
 * Pure. Covered by scripts/test-tools.mjs.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'listItem'; level: number; ordered: boolean; marker: string; runs: Run[] }
  | { kind: 'table'; rows: Run[][][] }
  | { kind: 'image'; dataUri: string }
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
  selfClosing: boolean;
  attrs: string;
}

function parseTag(raw: string): Tag {
  const closing = raw.startsWith('</');
  const inner = raw.replace(/^<\/?/, '').replace(/\/?>$/, '');
  const space = inner.search(/\s/);
  return {
    name: (space === -1 ? inner : inner.slice(0, space)).toLowerCase(),
    closing,
    selfClosing: raw.endsWith('/>'),
    attrs: space === -1 ? '' : inner.slice(space),
  };
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
    ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  return m ? m[1] : undefined;
};

/** Merges adjacent runs with identical styling and drops empty ones. */
export function tidyRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  // Collapse runs of whitespace, as HTML rendering would.
  for (const run of out) run.text = run.text.replace(/\s+/g, ' ');
  // Trim only at the very edges of the block.
  if (out.length) {
    out[0].text = out[0].text.replace(/^ +/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '');
  }
  return out.filter((r) => r.text.length);
}

const HEADINGS: Record<string, 1 | 2 | 3> = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };

/**
 * Parses mammoth's HTML into blocks.
 *
 * Unknown tags are transparent: their text still comes through, so an
 * unexpected wrapper never silently swallows content.
 */
export function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];

  // Inline styling state, and the list/table context.
  let bold = 0;
  let italic = 0;
  const listStack: { ordered: boolean; count: number }[] = [];

  let runs: Run[] = [];
  let current: { kind: 'heading'; level: 1 | 2 | 3 } | { kind: 'paragraph' } | { kind: 'listItem' } | null = null;

  // Table accumulation.
  let table: Run[][][] | null = null;
  let row: Run[][] | null = null;
  let cell: Run[] | null = null;

  const pushText = (text: string) => {
    if (!text) return;
    const run: Run = { text: decodeEntities(text) };
    if (bold > 0) run.bold = true;
    if (italic > 0) run.italic = true;
    if (cell) cell.push(run);
    else runs.push(run);
  };

  const flush = () => {
    const tidy = tidyRuns(runs);
    runs = [];

    // Text that never sat inside a <p> or heading still has to survive.
    // mammoth normally wraps everything, but a stray text node or an
    // unrecognised wrapper would otherwise be dropped without a trace — the
    // worst possible failure for a document converter.
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
          marker: top?.ordered ? `${top.count}.` : '•',
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
        bold += tag.closing ? -1 : 1;
        bold = Math.max(0, bold);
        break;
      case 'em':
      case 'i':
        italic += tag.closing ? -1 : 1;
        italic = Math.max(0, italic);
        break;

      case 'br':
        // A hard break inside a block: treat as a space, since the layout pass
        // re-wraps anyway and an empty line here would be misleading.
        pushText(' ');
        break;

      case 'hr':
        flush();
        blocks.push({ kind: 'rule' });
        break;

      case 'img': {
        const src = attr(tag.attrs, 'src');
        // mammoth inlines images as data URIs; anything else we cannot fetch.
        if (src?.startsWith('data:image/')) blocks.push({ kind: 'image', dataUri: src });
        break;
      }

      case 'ul':
      case 'ol':
        if (tag.closing) listStack.pop();
        else listStack.push({ ordered: tag.name === 'ol', count: 0 });
        break;

      case 'li':
        if (tag.closing) {
          flush();
        } else {
          flush();
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
          if (row && cell) row.push(tidyRuns(cell));
          cell = null;
        } else {
          cell = [];
        }
        break;

      default: {
        const level = HEADINGS[tag.name];
        if (level) {
          flush();
          if (!tag.closing) current = { kind: 'heading', level };
        } else if (tag.name === 'p') {
          if (tag.closing) {
            // A <p> inside a cell contributes to that cell, not a new block.
            if (!cell) flush();
          } else if (!cell) {
            flush();
            current = { kind: 'paragraph' };
          }
        }
        // Everything else (span, a, div…) is transparent: text still flows.
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
export function unsupportedCharacters(blocks: Block[]): string[] {
  const found = new Set<string>();

  const scan = (text: string) => {
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      // Tab, newline and space are handled by the layout pass.
      if (code === 9 || code === 10 || code === 13 || code === 32) continue;
      if (code < 0x20) continue;
      if (code <= 0xff) continue;
      // A handful above Latin-1 do exist in WinAnsi.
      if ('–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜'.includes(ch)) continue;
      found.add(ch);
    }
  };

  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row) for (const run of cell) scan(run.text);
    } else if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'listItem') {
      for (const run of block.runs) scan(run.text);
      if (block.kind === 'listItem') scan(block.marker);
    }
  }
  return [...found];
}

/** Plain text of a block, for measuring and for tests. */
export const blockText = (block: Block): string => {
  if (block.kind === 'table') {
    return block.rows.map((r) => r.map((c) => c.map((x) => x.text).join('')).join('\t')).join('\n');
  }
  if (block.kind === 'image') return '';
  if (block.kind === 'rule') return '';
  return block.runs.map((r) => r.text).join('');
};
