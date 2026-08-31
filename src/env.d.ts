/// <reference types="astro/client" />

/**
 * Astro's client types cover asset imports but not Vite's `?url` suffix, which
 * pdf-to-jpg needs to hand pdf.js a real URL for its worker bundle.
 */
declare module '*?url' {
  const src: string;
  export default src;
}

/**
 * bidi-js ships no types. Only the two entry points the Word converter uses are
 * declared, rather than pulling in a hand-written full surface that could drift
 * from the library.
 */
declare module 'bidi-js' {
  interface BidiApi {
    getEmbeddingLevels(
      text: string,
      direction?: 'ltr' | 'rtl' | 'auto',
    ): { levels: Uint8Array; paragraphs: { level: number; start: number; end: number }[] };
    getReorderSegments(
      text: string,
      embeddingLevels: { levels: Uint8Array },
    ): [number, number][];
  }
  export default function bidiFactory(): BidiApi;
}
