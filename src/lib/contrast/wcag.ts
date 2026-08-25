import type { RGB } from '../color/convert.ts';
import { rgbToOklch, oklchToRgb } from '../color/convert.ts';

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

export interface Compliance {
  ratio: number;
  /** Normal text: < 18.66px bold, < 24px regular. */
  aaNormal: boolean;
  aaaNormal: boolean;
  /** Large text: >= 18.66px bold or >= 24px regular. */
  aaLarge: boolean;
  aaaLarge: boolean;
  /** Icons, borders, form outlines — WCAG 1.4.11. */
  uiComponent: boolean;
}

export const THRESHOLDS = {
  aaNormal: 4.5,
  aaaNormal: 7,
  aaLarge: 3,
  aaaLarge: 4.5,
  uiComponent: 3,
} as const;

export function evaluate(fg: RGB, bg: RGB): Compliance {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio,
    aaNormal: ratio >= THRESHOLDS.aaNormal,
    aaaNormal: ratio >= THRESHOLDS.aaaNormal,
    aaLarge: ratio >= THRESHOLDS.aaLarge,
    aaaLarge: ratio >= THRESHOLDS.aaaLarge,
    uiComponent: ratio >= THRESHOLDS.uiComponent,
  };
}

/**
 * Nudges `fg` to hit `target` contrast against `bg` while changing it as little
 * as possible: hue and chroma are held, only OKLCH lightness moves, so the fix
 * still looks like the color the user picked.
 *
 * Tries the direction with more headroom first (darken on a light background,
 * lighten on a dark one) and binary-searches the smallest lightness shift that
 * clears the target. Returns null when neither direction can reach it — which
 * happens for a mid-grey background at target 7.
 */
export function fixContrast(fg: RGB, bg: RGB, target: number): RGB | null {
  if (contrastRatio(fg, bg) >= target) return fg;

  const base = rgbToOklch(fg);
  const bgLum = relativeLuminance(bg);
  // A light background has more room downward, a dark one more room upward.
  const dirs = bgLum > 0.18 ? [-1, 1] : [1, -1];

  for (const dir of dirs) {
    const limit = dir === 1 ? 1 : 0;
    // Does the extreme in this direction even clear the target?
    if (contrastRatio(oklchToRgb({ ...base, l: limit }), bg) < target) continue;

    let lo = base.l;
    let hi = limit;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(oklchToRgb({ ...base, l: mid }), bg) >= target) hi = mid;
      else lo = mid;
    }
    return oklchToRgb({ ...base, l: hi });
  }

  return null;
}

/** Black or white, whichever reads better on the given background. */
export function bestTextOn(bg: RGB): RGB {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  return contrastRatio(black, bg) >= contrastRatio(white, bg) ? black : white;
}
