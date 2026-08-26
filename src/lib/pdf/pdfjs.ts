/**
 * pdf.js loader.
 *
 * Everything is dynamically imported: pdf.mjs is ~450 kB and its worker ~1.2 MB,
 * so nothing here should load until the visitor actually picks a PDF.
 *
 * The support files (CMaps, standard fonts, WASM decoders, ICC profile) are
 * copied out of node_modules into public/pdfjs by scripts/sync-pdfjs.mjs and
 * fetched lazily by pdf.js — only a PDF that needs CJK, or a non-embedded
 * standard font, or a JBIG2/JPX image pays for them. Serving them ourselves
 * rather than from a CDN is what keeps the tool working offline and keeps the
 * promise that nothing about the file leaves the device.
 */

type PdfjsModule = typeof import('pdfjs-dist');

let cached: Promise<PdfjsModule> | null = null;

const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export const PDFJS_ASSETS = {
  cMapUrl: `${base}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  wasmUrl: `${base}pdfjs/wasm/`,
  iccUrl: `${base}pdfjs/iccs/`,
} as const;

/** Loads pdf.js once per page and points it at its worker. */
export function loadPdfjs(): Promise<PdfjsModule> {
  cached ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    // Without this pdf.js falls back to "fake worker" mode, which parses on the
    // main thread and locks the tab solid on anything but a tiny file.
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return cached;
}

/** Thrown for an encrypted PDF so the UI can ask for the password. */
export class PasswordRequired extends Error {
  /** true when a password was supplied and rejected, false when none was given. */
  readonly wrong: boolean;

  // Field + assignment, not a constructor parameter property: the latter is
  // TypeScript-only syntax that Node's type stripping refuses.
  constructor(wrong: boolean) {
    super(wrong ? 'That password did not work' : 'This PDF is password-protected');
    this.wrong = wrong;
    this.name = 'PasswordRequired';
  }
}

export interface OpenResult {
  doc: import('pdfjs-dist').PDFDocumentProxy;
  pages: number;
}

/**
 * Opens `data` as a PDF.
 *
 * The buffer is transferred to the worker, so the caller must not reuse it
 * afterwards — each call gets its own copy from the File.
 */
export async function openPdf(data: Uint8Array, password?: string): Promise<OpenResult> {
  const pdfjs = await loadPdfjs();
  try {
    const doc = await pdfjs.getDocument({
      data,
      password,
      ...PDFJS_ASSETS,
      // Big pages are rendered one at a time; caching every decoded image
      // across the whole document is what actually exhausts memory.
      disableAutoFetch: true,
    }).promise;
    return { doc, pages: doc.numPages };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') {
      // code 1 = needed, 2 = supplied but incorrect.
      throw new PasswordRequired((err as { code?: number }).code === 2);
    }
    if (name === 'InvalidPDFException') throw new Error('That file is not a readable PDF');
    throw err;
  }
}
