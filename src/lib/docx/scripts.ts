/**
 * Which font covers which character, and how to cut a run into pieces that
 * each have one.
 *
 * Carlito covers Latin, Latin-extended, Cyrillic, Greek and Vietnamese, and it
 * is metric-compatible with Calibri, so it stays the default for all of those.
 * Everything else needs a font that actually contains the glyphs, and the Noto
 * families are split by script — so a document mixing English and Hindi needs
 * two fonts on the same line, which means cutting each run at the boundaries.
 *
 * The cut points matter more than they look. Splitting inside a grapheme
 * cluster would destroy shaping: Devanagari conjuncts and Arabic joining are
 * computed per run by the shaper, so a run boundary in the middle of "नि" would
 * render the matra detached. Two rules prevent that:
 *
 *   1. A script's own block includes its combining marks and viramas, so a
 *      cluster never straddles a boundary by accident.
 *   2. Zero-width joiners and non-joiners live in General Punctuation, which
 *      would otherwise resolve to Latin and cut a conjunct in half. They — and
 *      spaces — inherit the run they appear in instead.
 */

/** A script that needs its own font file. */
export interface ScriptFont {
  key: string;
  /** File in public/fonts. */
  file: string;
  /** Shown to the reader when the script cannot be drawn. */
  label: string;
  /** Inclusive codepoint ranges this font is responsible for. */
  ranges: readonly (readonly [number, number])[];
}

/** The default: Carlito, and the only one that carries bold and italic faces. */
export const LATIN = 'latin';

/**
 * Adding a script is one entry here plus the .ttf in public/fonts. Nothing else
 * in the pipeline needs to change.
 */
export const SCRIPT_FONTS: readonly ScriptFont[] = [
  {
    key: 'devanagari',
    file: 'NotoSansDevanagari.ttf',
    label: 'Devanagari (Hindi, Marathi, Sanskrit, Nepali)',
    ranges: [
      [0x0900, 0x097f],
      [0xa8e0, 0xa8ff], // Devanagari Extended
      [0x1cd0, 0x1cff], // Vedic Extensions
    ],
  },
  { key: 'bengali', file: 'NotoSansBengali.ttf', label: 'Bengali', ranges: [[0x0980, 0x09ff]] },
  { key: 'gurmukhi', file: 'NotoSansGurmukhi.ttf', label: 'Gurmukhi (Punjabi)', ranges: [[0x0a00, 0x0a7f]] },
  { key: 'gujarati', file: 'NotoSansGujarati.ttf', label: 'Gujarati', ranges: [[0x0a80, 0x0aff]] },
  { key: 'oriya', file: 'NotoSansOriya.ttf', label: 'Odia', ranges: [[0x0b00, 0x0b7f]] },
  { key: 'tamil', file: 'NotoSansTamil.ttf', label: 'Tamil', ranges: [[0x0b80, 0x0bff]] },
  { key: 'telugu', file: 'NotoSansTelugu.ttf', label: 'Telugu', ranges: [[0x0c00, 0x0c7f]] },
  { key: 'kannada', file: 'NotoSansKannada.ttf', label: 'Kannada', ranges: [[0x0c80, 0x0cff]] },
  { key: 'malayalam', file: 'NotoSansMalayalam.ttf', label: 'Malayalam', ranges: [[0x0d00, 0x0d7f]] },
  { key: 'hebrew', file: 'NotoSansHebrew.ttf', label: 'Hebrew', ranges: [[0x0590, 0x05ff]] },
  {
    key: 'arabic',
    file: 'NotoSansArabic.ttf',
    label: 'Arabic',
    ranges: [
      [0x0600, 0x06ff],
      [0x0750, 0x077f], // Arabic Supplement
      [0x08a0, 0x08ff], // Arabic Extended-A
      [0xfb50, 0xfdff], // Presentation Forms-A
      [0xfe70, 0xfeff], // Presentation Forms-B
    ],
  },
  { key: 'thai', file: 'NotoSansThai.ttf', label: 'Thai', ranges: [[0x0e00, 0x0e7f]] },
];

/** Scripts written right to left, where a mixed line would need bidi. */
export const RTL_SCRIPTS: ReadonlySet<string> = new Set(['arabic', 'hebrew']);

const byKey = new Map(SCRIPT_FONTS.map((s) => [s.key, s]));
export const scriptFont = (key: string): ScriptFont | undefined => byKey.get(key);

/**
 * Characters that take the script of whatever they appear in rather than
 * carrying one of their own.
 *
 * ZWJ and ZWNJ are the important ones: Indic conjuncts are written with them,
 * they sit in General Punctuation, and resolving them to Latin would cut a
 * cluster in two and break the shaping. Space is included to stop a Hindi
 * sentence fragmenting into a font switch at every word.
 */
function isNeutral(codePoint: number): boolean {
  return (
    codePoint === 0x20 || // space
    codePoint === 0x09 || // tab
    codePoint === 0x200c || // ZWNJ
    codePoint === 0x200d || // ZWJ
    codePoint === 0x00a0 || // no-break space
    codePoint === 0x00ad || // soft hyphen
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) // variation selectors
  );
}

/** The font key responsible for a codepoint, defaulting to Latin. */
export function scriptKeyFor(codePoint: number): string {
  for (const font of SCRIPT_FONTS) {
    for (const [lo, hi] of font.ranges) {
      if (codePoint >= lo && codePoint <= hi) return font.key;
    }
  }
  return LATIN;
}

/** Every non-Latin script appearing in a string. */
export function scriptsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const ch of text) {
    const key = scriptKeyFor(ch.codePointAt(0) ?? 0);
    if (key !== LATIN) found.add(key);
  }
  return found;
}

export interface ScriptSegment {
  text: string;
  script: string;
}

/**
 * Cuts a string into maximal same-script segments.
 *
 * Neutral characters extend the current segment rather than starting a Latin
 * one, and a leading run of neutrals belongs to whatever follows them — so
 * " नमस्ते" is one Devanagari segment, not a Latin space plus Hindi.
 */
export function segmentByScript(text: string): ScriptSegment[] {
  if (!text) return [];

  const chars = [...text];
  const keys = chars.map((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return isNeutral(cp) ? null : scriptKeyFor(cp);
  });

  // Neutrals adopt the nearest decided script, looking back first so a trailing
  // space stays with the words before it.
  const resolved: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    if (key === null) {
      key = resolved[i - 1] ?? keys.slice(i + 1).find((k): k is string => k !== null) ?? LATIN;
    }
    resolved.push(key);
  }

  const out: ScriptSegment[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = out[out.length - 1];
    if (last && last.script === resolved[i]) last.text += chars[i];
    else out.push({ text: chars[i], script: resolved[i] });
  }
  return out;
}
