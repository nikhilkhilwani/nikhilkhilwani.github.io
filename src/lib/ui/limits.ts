/**
 * Input limits.
 *
 * Everything here runs in the visitor's tab, so the ceiling is that tab's
 * memory, not a server quota. Exceeding it does not produce an error — the tab
 * dies, taking any other work in it with it. That is the worst failure this
 * site can inflict, and it fails silently, so the limits are enforced before
 * a file is ever decoded.
 *
 * The numbers are deliberately conservative because mobile is the tight case:
 * desktop tabs get gigabytes, while Safari on an iPhone starts killing tabs a
 * few hundred megabytes in.
 *
 * All of this is pure and covered by scripts/test-tools.mjs.
 */

const MB = 1024 * 1024;

export const LIMITS = {
  /**
   * Per image. A JPEG decodes to width x height x 4 bytes regardless of how
   * well it compressed, so a 40 MB photo can still be ~1 GB of pixels. File
   * size is only a proxy; decode failure is caught separately.
   */
  image: 40 * MB,

  /** Per PDF. Parsing holds the bytes, the object graph, and the output at once. */
  pdf: 80 * MB,

  /** Across a batch, for the tools that keep every file in memory at once. */
  batch: 200 * MB,

  /**
   * Pixels in a single render canvas. 40 MP is ~160 MB of RGBA — survivable on
   * desktop, and about the point where mobile gives up. An A0 poster at 288 dpi
   * lands here, which is exactly the case that used to kill the tab.
   */
  canvasPixels: 40_000_000,
} as const;

export interface SizedFile {
  name: string;
  size: number;
}

export interface Rejection {
  name: string;
  size: number;
  reason: string;
}

export interface ScreenResult<T extends SizedFile> {
  accepted: T[];
  rejected: Rejection[];
}

/**
 * Splits `files` into what may be processed and what must be refused.
 *
 * `alreadyHeld` lets a tool that accumulates files count what it is already
 * holding towards the batch total, so the tenth drop is refused rather than
 * being the one that kills the tab.
 */
export function screenFiles<T extends SizedFile>(
  files: T[],
  opts: { perFile: number; total?: number; alreadyHeld?: number },
): ScreenResult<T> {
  const accepted: T[] = [];
  const rejected: Rejection[] = [];
  let running = opts.alreadyHeld ?? 0;

  for (const file of files) {
    if (file.size > opts.perFile) {
      rejected.push({
        name: file.name,
        size: file.size,
        reason: `over the ${formatLimit(opts.perFile)} limit for one file`,
      });
      continue;
    }
    if (opts.total !== undefined && running + file.size > opts.total) {
      rejected.push({
        name: file.name,
        size: file.size,
        reason: `would put this batch over ${formatLimit(opts.total)}`,
      });
      continue;
    }
    running += file.size;
    accepted.push(file);
  }

  return { accepted, rejected };
}

/** Whole megabytes — a limit reads better as "40 MB" than "40.0 MB". */
export function formatLimit(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/** One sentence naming what was refused and why. */
export function describeRejections(rejected: Rejection[]): string {
  if (!rejected.length) return '';
  if (rejected.length === 1) {
    return `${rejected[0].name} was skipped — ${rejected[0].reason}.`;
  }
  const reasons = new Set(rejected.map((r) => r.reason));
  const why = reasons.size === 1 ? ` — ${[...reasons][0]}` : '';
  return `${rejected.length} files were skipped${why}.`;
}

/** Pixels a page would occupy on canvas at `scale`. */
export function canvasPixelsFor(width: number, height: number, scale: number): number {
  return Math.ceil(width * scale) * Math.ceil(height * scale);
}

/**
 * The largest scale that keeps a page inside the canvas budget, rounded down to
 * one decimal. Used to suggest a workable resolution instead of only refusing.
 */
export function largestSafeScale(
  width: number,
  height: number,
  budget = LIMITS.canvasPixels,
): number {
  if (width <= 0 || height <= 0) return 1;
  const exact = Math.sqrt(budget / (width * height));
  return Math.max(0.1, Math.floor(exact * 10) / 10);
}

export const exceedsCanvasBudget = (pixels: number, budget = LIMITS.canvasPixels): boolean =>
  pixels > budget;
