/**
 * Font loading for the Word converter.
 *
 * Why this exists: the built-in PDF fonts (standard 14) are WinAnsi-encoded, so
 * every character above U+00FF became "?" — Cyrillic, Greek, Vietnamese, all the
 * Latin-extended accents, and every Indic script. Their metrics are also nothing
 * like Word's, so line breaks and page counts drifted from the source document.
 *
 * Carlito fixes the Latin half of that. Its advance widths are byte-identical to
 * Calibri's — measured against the Calibri shipped with Windows, 0.0000%
 * divergence across sample strings — so wrapping now matches what Word did, and
 * its coverage adds Latin-extended, Cyrillic, Greek and Vietnamese. It is
 * metric-compatible by design and OFL licensed, which is why LibreOffice
 * substitutes it for Calibri.
 *
 * Everything else comes from a per-script Noto font, loaded only if the document
 * actually contains that script. See scripts.ts for the mapping.
 *
 * Three things that are load-bearing and easy to break:
 *
 *   1. The FULL `fontkit` is required, not `@pdf-lib/fontkit`. The stripped
 *      build throws "Cannot read properties of undefined (reading 'pos')" when
 *      pdf-lib subsets, which forces whole-font embedding: a 278KB PDF instead
 *      of 12KB, AND a broken ToUnicode table where "Latin" extracts as "Laࢢn"
 *      because the ti ligature reverse-maps to the wrong character.
 *
 *   2. `subset: true` is therefore mandatory, not an optimisation. It is also
 *      what makes complex scripts work at all: embedding a whole variable font
 *      produced a font program pdf.js rejected ("Required 'loca' table is not
 *      found"), so viewers substituted a font and drew correct glyph IDs against
 *      the wrong glyph set — which looks exactly like broken shaping.
 *
 *   3. Only .ttf/.otf may be embedded. pdf-lib accepts WOFF without complaint
 *      and writes the compressed bytes as a TrueType program, producing that
 *      same silently-substituted garbage.
 *
 * Failure is never fatal: a script whose font will not load is reported as
 * undrawable, and if Carlito itself fails the caller keeps the built-in fonts.
 */

import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';
import { LATIN, scriptFont, scriptKeyFor } from './scripts.ts';

export type StyleKey = 'regular' | 'bold' | 'italic' | 'boldItalic';

export const LATIN_FONT_FILE: Record<StyleKey, string> = {
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

/** One script's faces. Script fonts ship a single weight, so all four match. */
export interface FontSet {
  faces: Record<StyleKey, PDFFont>;
  hasGlyph: (codePoint: number) => boolean;
  /**
   * True when every face is the same file, so bold and italic have to be
   * synthesised at draw time. The Noto script fonts bundled here ship one
   * weight, and pdf-lib cannot instantiate a variable font's wght axis.
   */
  synthetic: boolean;
}

export interface LoadedFonts {
  /** Keyed by script key from scripts.ts; always contains LATIN. */
  sets: Map<string, FontSet>;
  /** Asks whichever set is responsible for that codepoint. */
  hasGlyph: (codePoint: number) => boolean;
  /** Scripts present in the document whose font could not be loaded. */
  missing: string[];
}

/** Reads the committed fonts from public/fonts at runtime. */
export function browserFontSource(base = '/'): FontSource {
  return async (file) => {
    const res = await fetch(`${base}fonts/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** The Latin styles to fetch for a given set of needs, regular always included. */
export function stylesFor(needs: StyleNeeds): StyleKey[] {
  const keys: StyleKey[] = ['regular'];
  if (needs.bold) keys.push('bold');
  if (needs.italic) keys.push('italic');
  if (needs.boldItalic) keys.push('boldItalic');
  return keys;
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

/** Coverage probe over the raw bytes, cached because layout asks repeatedly. */
function glyphProbe(fontkit: typeof import('fontkit'), bytes: Uint8Array) {
  // fontkit.create() can also return a FontCollection (a .ttc holding several
  // faces). These are single-face files, but the union has to be narrowed
  // rather than asserted away.
  const font = fontkit.create(bytes as Uint8Array & Buffer);
  const ask =
    'hasGlyphForCodePoint' in font
      ? (cp: number) => font.hasGlyphForCodePoint(cp) === true
      : () => false;

  const cache = new Map<number, boolean>();
  return (codePoint: number): boolean => {
    const known = cache.get(codePoint);
    if (known !== undefined) return known;
    let answer = false;
    try {
      answer = ask(codePoint);
    } catch {
      answer = false;
    }
    cache.set(codePoint, answer);
    return answer;
  };
}

/**
 * Embeds Carlito plus a font for each script the document uses, or returns null
 * if Carlito itself cannot be loaded.
 *
 * Latin is all-or-nothing on purpose: mixing Carlito with a standard-14 fallback
 * inside one document would give it two sets of metrics and inconsistent line
 * breaks, which is worse than consistently using the old fonts. A per-script
 * failure is not fatal, though — those characters are reported as undrawable and
 * the rest of the document still converts.
 */
export async function loadFonts(
  pdf: PDFDocument,
  needs: StyleNeeds,
  scripts: Iterable<string>,
  source: FontSource,
): Promise<LoadedFonts | null> {
  let fontkit: typeof import('fontkit');
  try {
    // Dynamic so a page that never converts anything does not pay for it.
    fontkit = await import('fontkit');
    pdf.registerFontkit(fontkit as Parameters<PDFDocument['registerFontkit']>[0]);
  } catch {
    return null;
  }

  const sets = new Map<string, FontSet>();
  const missing: string[] = [];

  /* ---- Latin, required ---- */
  try {
    const wanted = stylesFor(needs);
    const bytes = new Map<StyleKey, Uint8Array>();
    await Promise.all(
      wanted.map(async (key) => {
        bytes.set(key, await source(LATIN_FONT_FILE[key]));
      }),
    );

    const embedded = new Map<StyleKey, PDFFont>();
    for (const key of wanted) {
      // subset:true is required — see the notes at the top of this file.
      embedded.set(key, await pdf.embedFont(bytes.get(key)!, { subset: true }));
    }

    const regular = embedded.get('regular');
    if (!regular) return null;

    sets.set(LATIN, {
      // Unused styles reuse regular so the record is always complete. They are
      // never drawn with, because no run asked for them.
      faces: {
        regular,
        bold: embedded.get('bold') ?? regular,
        italic: embedded.get('italic') ?? regular,
        boldItalic: embedded.get('boldItalic') ?? regular,
      },
      hasGlyph: glyphProbe(fontkit, bytes.get('regular')!),
      // Carlito ships all four faces, so nothing needs synthesising.
      synthetic: false,
    });
  } catch {
    return null;
  }

  /* ---- one file per script, each optional ---- */
  for (const key of scripts) {
    if (key === LATIN || sets.has(key)) continue;
    const meta = scriptFont(key);
    if (!meta) {
      missing.push(key);
      continue;
    }
    try {
      const bytes = await source(meta.file);
      const face = await pdf.embedFont(bytes, { subset: true });
      // Noto ships one weight per script here, so all four faces are the same
      // file and `synthetic` tells the renderer to embolden and slant itself.
      sets.set(key, {
        faces: { regular: face, bold: face, italic: face, boldItalic: face },
        hasGlyph: glyphProbe(fontkit, bytes),
        synthetic: true,
      });
    } catch {
      missing.push(key);
    }
  }

  const hasGlyph = (codePoint: number): boolean => {
    const set = sets.get(scriptKeyFor(codePoint));
    return set ? set.hasGlyph(codePoint) : false;
  };

  return { sets, hasGlyph, missing };
}
