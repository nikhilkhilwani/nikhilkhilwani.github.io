/**
 * Footnotes at the foot of the page they belong to.
 *
 * mammoth already does the hard part: it inlines a `[1]` marker linking
 * `#footnote-N` and appends the note text as an ordered list whose items link
 * back to `#footnote-ref-N`. So the content and the numbering arrive for free,
 * and footnotes.xml never has to be parsed — the work is purely placement.
 *
 * Placement is circular, which is why it stayed unimplemented for so long: how
 * much room to reserve at the foot of a page depends on which notes land there,
 * which depends on where the pagination falls, which depends on how much room
 * was reserved. The caller resolves it by laying out repeatedly until the
 * reservation stops changing.
 */

import type { Block } from './blocks.ts';

/** `#footnote-2` -> `2`, and nothing for any other link. */
export function markerId(href: string | undefined): string | null {
  if (!href) return null;
  const found = /^#footnote-(\w+)$/.exec(href);
  return found ? found[1] : null;
}

/** `#footnote-ref-2` -> `2`; this is the link INSIDE a note, pointing back. */
export function backReferenceId(href: string | undefined): string | null {
  if (!href) return null;
  const found = /^#footnote-ref-(\w+)$/.exec(href);
  return found ? found[1] : null;
}

export interface SplitNotes {
  /** The document without its trailing note list. */
  body: Block[];
  /** Note id -> the block holding its text, in document order. */
  notes: Map<string, Block>;
}

/**
 * Separates mammoth's note list from the body.
 *
 * A note is recognised by the back-link it contains rather than by position, so
 * a document that happens to end with an ordinary list is left alone.
 */
export function splitNotes(blocks: Block[]): SplitNotes {
  const notes = new Map<string, Block>();
  const body: Block[] = [];

  for (const block of blocks) {
    const runs = 'runs' in block ? block.runs : undefined;
    const id = runs?.map((run) => backReferenceId(run.anchor)).find((found) => found != null);
    if (id) {
      // Drop the back-link itself: an upward arrow to an anchor is meaningless
      // once the note is printed on the page it belongs to.
      const kept = runs!.filter((run) => backReferenceId(run.anchor) === null);
      notes.set(id, { ...block, runs: kept } as Block);
    } else {
      body.push(block);
    }
  }

  return { body, notes };
}

/** Note ids referenced by a block, in order. */
export function markersIn(block: Block): string[] {
  if (!('runs' in block) || !block.runs) return [];
  const out: string[] = [];
  for (const run of block.runs) {
    const id = markerId(run.anchor);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}
