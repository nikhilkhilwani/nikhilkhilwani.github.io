/**
 * Metric-compatible font loading for the Word converter.
 *
 * Why this exists: the built-in PDF fonts (standard 14) are WinAnsi-encoded, so
 * every character above U+00FF became "?" — Cyrillic, Greek, Vietnamese and all
 * the Latin-extended accents. Their metrics are also nothing like Word's, so
 * line breaks and page counts drifted from the source document.
 *
 * Carlito fixes both. Its advance widths are byte-identical to Calibri's —
 * measured against the Calibri shipped with Windows, 0.0000% divergence across
 * sample strings — so wrapping now matches what Word did, and its coverage adds
 * Latin-extended, Cyrillic, Greek and Vietnamese. It is metric-compatible by
 * design and OFL licensed, which is why LibreOffice substitutes it for Calibri.
 *
 * Two things that are load-bearing and easy to break:
 *
 *   1. The FULL `fontkit` is required, not `@pdf-lib/fontkit`. The stripped
 *      build throws "Cannot read properties of undefined (reading 'pos')" when
 *      pdf-lib subsets, which forces whole-font embedding: a 278KB PDF instead
 *      of 12KB, AND a broken ToUnicode table where "Latin" extracts as "Laࢢn"
 *      because the ti ligature reverse-maps to the wrong character. Subsetting
 *      with the real fontkit fixes the size and the extraction together.
 *
 *   2. `subset: true` is therefore mandatory, not an optimisation.
 *
 * Loading is lazy per style — a document with no italics never fetches the
 * italic file — and failure is never fatal: the caller falls back to the
 * built-in fonts, which is exactly what shipped before this existed.
 */

import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';

export type StyleKey = 'regular' | 'bold' | 'italic' | 'boldItalic';

export const FONT_FILE: Record<StyleKey, string> = {
  regular: 'Carlito-Regular.ttf',
  bold: 'Carlito-Bold.ttf',
  italic: 'Carlito-Italic.ttf',
  boldItalic: 'Carlito-BoldItalic.ttf',
};

/** Which faces a document actually uses. `regular` is always needed. */
export interface StyleNeeds {
  bold: boolean;
  italic: boolean;
  boldItalic: boolean;
}

/**
 * Injected rather than calling fetch() directly, so the Node tests can read the
 * same files off disk and exercise the real embedding path.
 */
export type FontSource = (file: string) => Promise<Uint8Array>;

export interface LoadedFonts {
  faces: Record<StyleKey, PDFFont>;
  /** True when a glyph exists, so the caller knows what it can actually draw. */
  hasGlyph: (codePoint: number) => boolean;
}

/** Reads the committed TTFs from public/fonts at runtime. */
export function browserFontSource(base = '/'): FontSource {
  return async (file) => {
    const res = await fetch(`${base}fonts/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** The styles to fetch for a given set of needs, regular always included. */
export function stylesFor(needs: StyleNeeds): StyleKey[] {
  const keys: StyleKey[] = ['regular'];
  if (needs.bold) keys.push('bold');
  if (needs.italic) keys.push('italic');
  if (needs.boldItalic) keys.push('boldItalic');
  return keys;
}

/**
 * Embeds the metric-compatible faces into `pdf`, or returns null if anything
 * goes wrong. All-or-nothing on purpose: mixing Carlito with a standard-14
 * fallback inside one document would give it two different sets of metrics and
 * inconsistent line breaks, which is worse than consistently using the old
 * fonts.
 */
export async function loadMetricFonts(
  pdf: PDFDocument,
  needs: StyleNeeds,
  source: FontSource,
): Promise<LoadedFonts | null> {
  try {
    // Dynamic so a conversion that never needs it does not pay for it, and so
    // a broken font bundle cannot take down module load.
    const fontkit = await import('fontkit');
    pdf.registerFontkit(fontkit as Parameters<PDFDocument['registerFontkit']>[0]);

    const wanted = stylesFor(needs);
    const bytes = new Map<StyleKey, Uint8Array>();
    await Promise.all(
      wanted.map(async (key) => {
        bytes.set(key, await source(FONT_FILE[key]));
      }),
    );

    const embedded = new Map<StyleKey, PDFFont>();
    for (const key of wanted) {
      // subset:true is required — see the note at the top of this file.
      embedded.set(key, await pdf.embedFont(bytes.get(key)!, { subset: true }));
    }

    const regular = embedded.get('regular');
    if (!regular) return null;

    // Unused styles reuse regular so `faces` is always complete. They are never
    // drawn with, because the document contained no runs in that style.
    const faces: Record<StyleKey, PDFFont> = {
      regular,
      bold: embedded.get('bold') ?? regular,
      italic: embedded.get('italic') ?? regular,
      boldItalic: embedded.get('boldItalic') ?? regular,
    };

    // Coverage is read from the regular face. Every Carlito style carries the
    // same character set, so asking one is equivalent to asking all four.
    const probe = fontkit.create(bytes.get('regular')! as Uint8Array & Buffer);
    // fontkit.create() can also return a FontCollection (a .ttc holding several
    // faces). These are single-face .ttf files, but the union has to be narrowed
    // rather than asserted away.
    const probeGlyph =
      'hasGlyphForCodePoint' in probe
        ? (codePoint: number) => probe.hasGlyphForCodePoint(codePoint) === true
        : () => false;

    const cache = new Map<number, boolean>();
    const hasGlyph = (codePoint: number): boolean => {
      const known = cache.get(codePoint);
      if (known !== undefined) return known;
      let answer = false;
      try {
        answer = probeGlyph(codePoint);
      } catch {
        answer = false;
      }
      cache.set(codePoint, answer);
      return answer;
    };

    return { faces, hasGlyph };
  } catch {
    // Never fatal: the caller keeps the built-in fonts.
    return null;
  }
}

/** Which faces the parsed runs actually call for. */
export function needsFromFlags(
  flags: Iterable<{ bold?: boolean; italic?: boolean }>,
): StyleNeeds {
  const needs: StyleNeeds = { bold: false, italic: false, boldItalic: false };
  for (const f of flags) {
    if (f.bold && f.italic) needs.boldItalic = true;
    else if (f.bold) needs.bold = true;
    else if (f.italic) needs.italic = true;
  }
  return needs;
}
