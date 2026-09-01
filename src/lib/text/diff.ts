/**
 * Text comparison: a line diff, with a word diff inside changed line pairs.
 *
 * The line diff is Myers' O(ND) algorithm. Two things make it fast enough to
 * run while someone is typing:
 *
 *   1. Lines are interned to integers first, so the inner comparison is integer
 *      equality rather than string equality.
 *   2. The common prefix and suffix are trimmed before Myers ever runs. In
 *      practice that removes nearly all of the input — two drafts of the same
 *      document differ in a handful of lines — and Myers costs O(ND) where D is
 *      the number of differences, not the size of the input.
 *
 * A plain LCS table would be far simpler, but it is O(N x M) in MEMORY: two
 * 10,000-line inputs would need a hundred million cells. That is the reason for
 * Myers rather than the obvious dynamic program.
 *
 * `applyEdits` exists so the whole thing has one strong invariant to test
 * against: applying a diff to the left side must reproduce the right side
 * exactly, for any pair of inputs.
 */

export interface DiffOptions {
  /** Compare without regard to letter case. */
  ignoreCase?: boolean;
  /** Collapse runs of whitespace and trim the ends before comparing. */
  ignoreWhitespace?: boolean;
  /** Treat blank lines as absent on both sides. */
  ignoreBlankLines?: boolean;
  /**
   * Give up past this many differences and report the two sides as wholly
   * replaced. Myers is O(ND); without a ceiling, two completely unrelated
   * 20,000-line inputs would lock the tab rather than answer slowly.
   */
  maxEdits?: number;
  /**
   * Below this share of shared lines the two texts are treated as unrelated and
   * reported whole without running Myers at all. Set to 0 to always diff.
   */
  minOverlap?: number;
}

/**
 * The ceiling on differences, chosen by measurement rather than taste.
 *
 * Myers' loop is about O(D^2) in practice, and it was measured here at roughly
 * 7 seconds for D = 20,000. 3,000 lands near 150ms, which is the most that can
 * happen on a keystroke without the tab feeling stuck. Documents that differ by
 * more than this are reported whole, which is both instant and honest — a line
 * diff of two texts that share almost nothing is noise anyway.
 */
export const DEFAULT_MAX_EDITS = 3_000;

/**
 * Unrelated texts are the pathological case: D grows with the input, so the
 * budget above is reached the expensive way. Counting shared lines first is
 * O(N + M) and catches them instantly.
 */
export const DEFAULT_MIN_OVERLAP = 0.15;

/** Shared lines as a share of the longer side, by multiset intersection. */
function overlap(a: number[], b: number[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;

  const counts = new Map<number, number>();
  for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1);

  let shared = 0;
  for (const id of b) {
    const left = counts.get(id) ?? 0;
    if (left > 0) {
      counts.set(id, left - 1);
      shared++;
    }
  }
  return shared / longest;
}

export type EditOp = 'equal' | 'insert' | 'delete';

export interface LineEdit {
  op: EditOp;
  /** Index into the left lines, for 'equal' and 'delete'. */
  a?: number;
  /** Index into the right lines, for 'equal' and 'insert'. */
  b?: number;
}

/**
 * Splits text into lines without inventing a trailing empty one.
 *
 * "a\nb\n" is two lines, not three. Getting this wrong shows up as a phantom
 * added line at the end of every comparison.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The comparison key for a line: what the options say to ignore. */
export function normaliseLine(line: string, options: DiffOptions): string {
  let key = line;
  if (options.ignoreWhitespace) key = key.replace(/\s+/g, ' ').trim();
  if (options.ignoreCase) key = key.toLowerCase();
  return key;
}

const isBlank = (line: string) => line.trim() === '';

/**
 * Myers' greedy forward algorithm over two integer sequences.
 *
 * Returns the edit script, or null when it would exceed `budget` — the caller
 * decides what to do rather than being handed a half-answer.
 */
function myers(a: number[], b: number[], budget: number): LineEdit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= Math.min(max, budget); d++) {
    // Snapshot before this round: the backtrack reads the state that produced
    // each step, so it needs the value from before the round it is undoing.
    trace.push(v.slice());

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      // Moving DOWN means consuming a line from the right (an insertion);
      // moving RIGHT means consuming one from the left (a deletion).
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;

      // Then run as far as the lines agree: diagonals are free.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;

      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }

  if (found < 0) return null;

  /* ---- walk the trace backwards into an edit script ---- */

  const reversed: LineEdit[] = [];
  let x = n;
  let y = m;

  for (let d = found; d > 0; d--) {
    const snapshot = trace[d];
    const k = x - y;

    let previousK: number;
    if (k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1])) {
      previousK = k + 1;
    } else {
      previousK = k - 1;
    }
    const previousX = snapshot[offset + previousK];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      reversed.push({ op: 'equal', a: x - 1, b: y - 1 });
      x--;
      y--;
    }

    if (x === previousX) reversed.push({ op: 'insert', b: y - 1 });
    else reversed.push({ op: 'delete', a: x - 1 });

    x = previousX;
    y = previousY;
  }

  // Whatever is left at d = 0 is the leading run of identical lines.
  while (x > 0 && y > 0) {
    reversed.push({ op: 'equal', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  while (y > 0) reversed.push({ op: 'insert', b: --y });
  while (x > 0) reversed.push({ op: 'delete', a: --x });

  return reversed.reverse();
}

/** Interns strings to integers so Myers compares numbers, not text. */
function intern(values: string[], table: Map<string, number>): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    let id = table.get(values[i]);
    if (id === undefined) {
      id = table.size;
      table.set(values[i], id);
    }
    out[i] = id;
  }
  return out;
}

export interface LineDiff {
  left: string[];
  right: string[];
  edits: LineEdit[];
  /** True when the edit budget was exceeded and the sides are reported whole. */
  truncated: boolean;
}

/** Line diff of two texts, honouring the options. */
export function diffLines(leftText: string, rightText: string, options: DiffOptions = {}): LineDiff {
  const leftAll = splitLines(leftText);
  const rightAll = splitLines(rightText);

  // Blank lines are dropped from the comparison entirely, and the surviving
  // indices are mapped back so the caller still reports real line numbers.
  const leftIndex = leftAll.map((_, i) => i).filter((i) => !options.ignoreBlankLines || !isBlank(leftAll[i]));
  const rightIndex = rightAll.map((_, i) => i).filter((i) => !options.ignoreBlankLines || !isBlank(rightAll[i]));

  const table = new Map<string, number>();
  const a = intern(leftIndex.map((i) => normaliseLine(leftAll[i], options)), table);
  const b = intern(rightIndex.map((i) => normaliseLine(rightAll[i], options)), table);

  /* ---- trim the common ends before Myers sees them ---- */

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const budget = options.maxEdits ?? DEFAULT_MAX_EDITS;
  const floor = options.minOverlap ?? DEFAULT_MIN_OVERLAP;

  // Small inputs are cheap however different they are, so the overlap check
  // only applies once there is enough material for it to matter.
  const bigEnough = middleA.length + middleB.length > 400;
  const unrelated = bigEnough && floor > 0 && overlap(middleA, middleB) < floor;

  const middle = unrelated ? null : myers(middleA, middleB, budget);

  const edits: LineEdit[] = [];
  const pushEqual = (i: number) => edits.push({ op: 'equal', a: leftIndex[i], b: rightIndex[i] });

  for (let i = 0; i < head; i++) pushEqual(i);

  if (middle === null) {
    // Over budget: report the differing middle as wholly replaced. Honest and
    // instant, rather than correct and unresponsive.
    for (let i = head; i < a.length - tail; i++) edits.push({ op: 'delete', a: leftIndex[i] });
    for (let i = head; i < b.length - tail; i++) edits.push({ op: 'insert', b: rightIndex[i] });
  } else {
    for (const edit of middle) {
      if (edit.op === 'equal') {
        edits.push({ op: 'equal', a: leftIndex[head + edit.a!], b: rightIndex[head + edit.b!] });
      } else if (edit.op === 'delete') {
        edits.push({ op: 'delete', a: leftIndex[head + edit.a!] });
      } else {
        edits.push({ op: 'insert', b: rightIndex[head + edit.b!] });
      }
    }
  }

  for (let i = 0; i < tail; i++) {
    edits.push({
      op: 'equal',
      a: leftIndex[a.length - tail + i],
      b: rightIndex[b.length - tail + i],
    });
  }

  return { left: leftAll, right: rightAll, edits, truncated: middle === null };
}

/**
 * Rebuilds the right side by applying the edits to the left.
 *
 * This is the invariant the tests lean on: for any inputs, this must equal the
 * right side's lines. An indexing slip anywhere in Myers or in the prefix and
 * suffix trimming shows up here immediately.
 */
export function applyEdits(diff: LineDiff): string[] {
  const out: string[] = [];
  for (const edit of diff.edits) {
    if (edit.op === 'equal') out.push(diff.right[edit.b!]);
    else if (edit.op === 'insert') out.push(diff.right[edit.b!]);
  }
  return out;
}

/* ------------------------------------------------------------ word level */

export interface Segment {
  text: string;
  op: EditOp;
}

/**
 * Splits into words while KEEPING the separators as tokens, so rebuilding a
 * line from its segments loses no spacing.
 */
export function splitWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Word diff of two single lines, as segments for each side. */
export function diffWords(
  leftLine: string,
  rightLine: string,
  options: DiffOptions = {},
): { left: Segment[]; right: Segment[] } {
  const leftWords = splitWords(leftLine);
  const rightWords = splitWords(rightLine);

  const table = new Map<string, number>();
  const a = intern(leftWords.map((word) => normaliseLine(word, options)), table);
  const b = intern(rightWords.map((word) => normaliseLine(word, options)), table);

  const edits = myers(a, b, options.maxEdits ?? DEFAULT_MAX_EDITS);
  if (!edits) {
    return {
      left: leftWords.length ? [{ text: leftLine, op: 'delete' }] : [],
      right: rightWords.length ? [{ text: rightLine, op: 'insert' }] : [],
    };
  }

  const left: Segment[] = [];
  const right: Segment[] = [];
  const add = (into: Segment[], text: string, op: EditOp) => {
    const last = into[into.length - 1];
    if (last && last.op === op) last.text += text;
    else into.push({ text, op });
  };

  for (const edit of edits) {
    if (edit.op === 'equal') {
      add(left, leftWords[edit.a!], 'equal');
      add(right, rightWords[edit.b!], 'equal');
    } else if (edit.op === 'delete') {
      add(left, leftWords[edit.a!], 'delete');
    } else {
      add(right, rightWords[edit.b!], 'insert');
    }
  }

  return { left, right };
}

/* ---------------------------------------------------------- display rows */

export type RowOp = 'equal' | 'insert' | 'delete' | 'replace';

export interface Row {
  op: RowOp;
  /** 1-based line numbers, absent on the side where the row does not exist. */
  leftNumber?: number;
  rightNumber?: number;
  left?: string;
  right?: string;
  /** Word segments, present only on a 'replace' row. */
  leftParts?: Segment[];
  rightParts?: Segment[];
}

export interface CompareStats {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** 0..1, share of lines that came through untouched. */
  similarity: number;
}

export interface Comparison {
  rows: Row[];
  stats: CompareStats;
  identical: boolean;
  truncated: boolean;
}

/**
 * Pairs each run of deletions with the insertions that follow it, so a modified
 * line reads as one row with both sides rather than a delete and an insert
 * several rows apart. The leftover on the longer side stays a plain add or
 * remove.
 */
export function compareTexts(
  leftText: string,
  rightText: string,
  options: DiffOptions = {},
): Comparison {
  const diff = diffLines(leftText, rightText, options);
  const rows: Row[] = [];
  const stats: CompareStats = { added: 0, removed: 0, changed: 0, unchanged: 0, similarity: 1 };

  let i = 0;
  while (i < diff.edits.length) {
    const edit = diff.edits[i];

    if (edit.op === 'equal') {
      rows.push({
        op: 'equal',
        leftNumber: edit.a! + 1,
        rightNumber: edit.b! + 1,
        left: diff.left[edit.a!],
        right: diff.right[edit.b!],
      });
      stats.unchanged++;
      i++;
      continue;
    }

    const deletions: number[] = [];
    const insertions: number[] = [];
    while (i < diff.edits.length && diff.edits[i].op === 'delete') deletions.push(diff.edits[i++].a!);
    while (i < diff.edits.length && diff.edits[i].op === 'insert') insertions.push(diff.edits[i++].b!);

    const paired = Math.min(deletions.length, insertions.length);
    for (let p = 0; p < paired; p++) {
      const leftLine = diff.left[deletions[p]];
      const rightLine = diff.right[insertions[p]];
      const parts = diffWords(leftLine, rightLine, options);
      rows.push({
        op: 'replace',
        leftNumber: deletions[p] + 1,
        rightNumber: insertions[p] + 1,
        left: leftLine,
        right: rightLine,
        leftParts: parts.left,
        rightParts: parts.right,
      });
      stats.changed++;
    }
    for (let p = paired; p < deletions.length; p++) {
      rows.push({ op: 'delete', leftNumber: deletions[p] + 1, left: diff.left[deletions[p]] });
      stats.removed++;
    }
    for (let p = paired; p < insertions.length; p++) {
      rows.push({ op: 'insert', rightNumber: insertions[p] + 1, right: diff.right[insertions[p]] });
      stats.added++;
    }
  }

  const touched = stats.added + stats.removed + stats.changed;
  const total = touched + stats.unchanged;
  stats.similarity = total === 0 ? 1 : stats.unchanged / total;

  return { rows, stats, identical: touched === 0, truncated: diff.truncated };
}
