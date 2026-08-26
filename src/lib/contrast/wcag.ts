/**
 * WCAG 2.1 contrast math. Kept for the QR generator, which warns when a
 * foreground/background pair is too close for scanners to separate reliably.
 */
import type { RGB } from '../color/convert.ts';

/** WCAG 2.1 relative luminance (same linearisation as sRGB, different weights). */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio, 1–21. Order of arguments does not matter. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
