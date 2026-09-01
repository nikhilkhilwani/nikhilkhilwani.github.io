/**
 * Unified diff output, so a comparison can leave the browser as a real .patch
 * that `git apply` and `patch` both understand.
 *
 * The format is fussy in two places that are easy to get wrong:
 *
 *   - Hunk headers count LINES, one-based, and a zero-length side is written
 *     with the line number BEFORE it, not after. An empty file compared against
 *     content therefore starts at 0, not 1.
 *   - Context lines are shared: two changes closer together than twice the
 *     context must merge into one hunk, or the output overlaps itself and no
 *     patch tool will take it.
 */

import type { LineDiff } from './diff.ts';

export interface PatchOptions {
  /** Lines of unchanged context either side of a change. */
  context?: number;
  leftName?: string;
  rightName?: string;
}

interface Hunk {
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  lines: string[];
}

export function toUnifiedDiff(diff: LineDiff, options: PatchOptions = {}): string {
  const context = Math.max(0, options.context ?? 3);
  const leftName = options.leftName ?? 'left';
  const rightName = options.rightName ?? 'right';

  const edits = diff.edits;
  const changed = edits
    .map((edit, index) => (edit.op === 'equal' ? -1 : index))
    .filter((index) => index >= 0);

  if (!changed.length) return '';

  /* ---- group changes whose context windows touch ---- */

  const groups: { from: number; to: number }[] = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    // Two changes merge when the gap between them is no wider than the context
    // either side would print anyway.
    if (last && index - last.to <= context * 2 + 1) last.to = index;
    else groups.push({ from: index, to: index });
  }

  const hunks: Hunk[] = [];
  for (const group of groups) {
    const from = Math.max(0, group.from - context);
    const to = Math.min(edits.length - 1, group.to + context);

    const lines: string[] = [];
    let leftStart = 0;
    let rightStart = 0;
    let leftCount = 0;
    let rightCount = 0;
    let seenLeft = false;
    let seenRight = false;

    for (let i = from; i <= to; i++) {
      const edit = edits[i];
      if (edit.op === 'equal') {
        if (!seenLeft) {
          leftStart = edit.a! + 1;
          seenLeft = true;
        }
        if (!seenRight) {
          rightStart = edit.b! + 1;
          seenRight = true;
        }
        leftCount++;
        rightCount++;
        lines.push(` ${diff.left[edit.a!]}`);
      } else if (edit.op === 'delete') {
        if (!seenLeft) {
          leftStart = edit.a! + 1;
          seenLeft = true;
        }
        leftCount++;
        lines.push(`-${diff.left[edit.a!]}`);
      } else {
        if (!seenRight) {
          rightStart = edit.b! + 1;
          seenRight = true;
        }
        rightCount++;
        lines.push(`+${diff.right[edit.b!]}`);
      }
    }

    // A side with no lines in the hunk is anchored to the line before it, which
    // is what the format expects and what patch tools check.
    if (!seenLeft) leftStart = 0;
    if (!seenRight) rightStart = 0;

    hunks.push({ leftStart, leftCount, rightStart, rightCount, lines });
  }

  const out: string[] = [`--- ${leftName}`, `+++ ${rightName}`];
  for (const hunk of hunks) {
    const left = hunk.leftCount === 1 ? `${hunk.leftStart}` : `${hunk.leftStart},${hunk.leftCount}`;
    const right = hunk.rightCount === 1 ? `${hunk.rightStart}` : `${hunk.rightStart},${hunk.rightCount}`;
    out.push(`@@ -${left} +${right} @@`);
    out.push(...hunk.lines);
  }

  return out.join('\n') + '\n';
}

/** Counts the hunks a patch contains, for the tests and the UI summary. */
export function countHunks(patch: string): number {
  return (patch.match(/^@@ /gm) ?? []).length;
}
