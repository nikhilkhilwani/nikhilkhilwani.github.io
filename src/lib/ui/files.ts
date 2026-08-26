/**
 * Filename, size, and MIME helpers shared by the image and PDF tools.
 * Everything here is pure so scripts/test-tools.mjs can cover it in Node.
 */

/** Image MIME types we can ask a canvas to encode. */
export const ENCODE_TYPES = {
  'image/png': { label: 'PNG', ext: 'png', lossy: false },
  'image/jpeg': { label: 'JPEG', ext: 'jpg', lossy: true },
  'image/webp': { label: 'WebP', ext: 'webp', lossy: true },
} as const;

export type EncodeType = keyof typeof ENCODE_TYPES;

export const isEncodeType = (v: string): v is EncodeType => v in ENCODE_TYPES;

/** 1 kB = 1024 B here, matching what desktop OSes report. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // Two significant-ish digits: 9.4 MB, but 94 MB rather than 94.3 MB.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Percentage saved going from `before` to `after`. Negative means it grew. */
export function savingsPercent(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

/** Strips any directory part and characters that break downloads on Windows. */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    // Drop what Windows/NTFS reserves, plus any C0 control code. Spaces,
    // hyphens, and dots survive: they are legal and users expect them kept.
    .filter((ch) => !'<>:"|?*'.includes(ch) && (ch.codePointAt(0) ?? 0) > 31)
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

/** Everything before the final dot — "shot.final.png" -> "shot.final". */
export function stemOf(name: string): string {
  const clean = sanitizeFilename(name);
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
}

/** Replaces the extension: ("photo.png", "jpg") -> "photo.jpg". */
export function withExtension(name: string, ext: string): string {
  return `${stemOf(name) || 'file'}.${ext.replace(/^\./, '')}`;
}

/**
 * Makes `name` unique against names already used, Explorer-style:
 * "a.png", then "a (2).png", "a (3).png".
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${taken.size + 1})${ext}`;
}

/** Zero-pads to the width of the largest index, so ZIP entries sort correctly. */
export function pageLabel(index: number, total: number): string {
  return String(index).padStart(String(total).length, '0');
}

/**
 * Parses a page-range expression against a document of `total` pages.
 * Accepts "1-5, 8, 11-", is order-insensitive, and de-duplicates.
 * Returns 1-based page numbers, ascending. Empty/blank means every page.
 */
export function parsePageRange(input: string, total: number): number[] {
  const all = () => Array.from({ length: total }, (_, i) => i + 1);
  if (total <= 0) return [];
  const text = input.trim();
  if (!text) return all();

  const pages = new Set<number>();
  for (const part of text.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = /^(\d*)\s*[-–]\s*(\d*)$/.exec(chunk);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : total;
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const lo = Math.max(1, Math.min(from, to));
      const hi = Math.min(total, Math.max(from, to));
      for (let p = lo; p <= hi; p++) pages.add(p);
      continue;
    }

    const single = Number(chunk);
    if (Number.isInteger(single) && single >= 1 && single <= total) pages.add(single);
  }
  return [...pages].sort((a, b) => a - b);
}
