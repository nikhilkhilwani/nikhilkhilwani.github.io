/**
 * Visual reordering for right-to-left text.
 *
 * wrapRuns splits a paragraph into whitespace-separated tokens and lays them
 * out left to right. For Arabic or Hebrew that puts the WORDS in the wrong
 * order — the glyphs inside each word are shaped correctly, but the words read
 * backwards. So even a paragraph that is entirely Arabic came out wrong, not
 * just a mixed-direction one.
 *
 * The levels come from bidi-js, a real implementation of UAX #9, rather than a
 * hand-rolled guess. Resolving neutrals is the part that is easy to get subtly
 * wrong: the space and parentheses in `مرحبا (hello) بالعالم` take their
 * direction from context, and mis-resolving them reorders the line plausibly
 * but incorrectly.
 *
 * Reordering happens at TOKEN granularity, which is exact for this model: every
 * piece is a single-script token or a run of spaces, so no piece straddles a
 * level boundary that bidi-js resolved.
 */

type Bidi = {
  getEmbeddingLevels: (
    text: string,
    direction?: 'ltr' | 'rtl' | 'auto',
  ) => { levels: Uint8Array; paragraphs: { level: number }[] };
};

let cached: Bidi | null = null;

/** Loaded lazily: a document with no RTL text never pays for it. */
export async function loadBidi(): Promise<Bidi> {
  if (cached) return cached;
  const mod = (await import('bidi-js')) as unknown as { default?: () => Bidi };
  const factory = mod.default ?? (mod as unknown as () => Bidi);
  cached = factory();
  return cached;
}

/** Injected so the pure tests can run without the dynamic import. */
export function setBidi(instance: Bidi | null): void {
  cached = instance;
}

export interface Reordered {
  /** Original indices in the order they should be drawn, left to right. */
  order: number[];
  /** True when the paragraph's own base direction resolved to right-to-left. */
  baseRtl: boolean;
}

/**
 * Applies UAX #9 rule L2 at token granularity.
 *
 * L2: from the highest level down to the lowest odd level, reverse any
 * contiguous run of tokens at that level or above.
 */
export function reorderTokens(
  bidi: Bidi,
  tokens: { text: string }[],
  direction: 'ltr' | 'rtl' | 'auto',
): Reordered {
  const order = tokens.map((_, index) => index);
  if (tokens.length < 2) {
    const single = tokens.map((t) => t.text).join('');
    const levels = single ? bidi.getEmbeddingLevels(single, direction) : null;
    return { order, baseRtl: (levels?.paragraphs[0]?.level ?? 0) % 2 === 1 };
  }

  const text = tokens.map((token) => token.text).join('');
  const resolved = bidi.getEmbeddingLevels(text, direction);
  const baseRtl = (resolved.paragraphs[0]?.level ?? 0) % 2 === 1;

  // The level of each token, taken at its first character. A token is one
  // script or one stretch of spaces, so its characters share a level.
  const levelOf: number[] = [];
  let offset = 0;
  for (const token of tokens) {
    levelOf.push(resolved.levels[offset] ?? 0);
    offset += token.text.length;
  }

  let highest = 0;
  let lowestOdd = Number.POSITIVE_INFINITY;
  for (const level of levelOf) {
    if (level > highest) highest = level;
    if (level % 2 === 1 && level < lowestOdd) lowestOdd = level;
  }
  if (!Number.isFinite(lowestOdd)) return { order, baseRtl };

  const reverse = (from: number, to: number) => {
    while (from < to) {
      const swap = order[from];
      order[from] = order[to];
      order[to] = swap;
      from++;
      to--;
    }
  };

  for (let level = highest; level >= lowestOdd; level--) {
    let i = 0;
    while (i < order.length) {
      if (levelOf[order[i]] >= level) {
        let j = i;
        while (j + 1 < order.length && levelOf[order[j + 1]] >= level) j++;
        reverse(i, j);
        i = j + 1;
      } else {
        i++;
      }
    }
  }

  return { order, baseRtl };
}
