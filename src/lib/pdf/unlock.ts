/**
 * Removes password protection from a PDF whose password the visitor knows.
 * This is decrypt-and-resave, not password recovery — nothing here attempts to
 * guess or break a password.
 *
 * The approach was chosen by measurement, not preference. Three strategies were
 * tried against @cantoo/pdf-lib 2.9.1:
 *
 *   load({password}) then save()          -> /Encrypt SURVIVES in the xref
 *                                            dictionary; the library refuses to
 *                                            reopen its own output.
 *   clear context.security / trailerInfo  -> no effect; the reference is not
 *                                            written from either of those.
 *   copy pages into a fresh document      -> genuinely clean, reopens
 *                                            everywhere, and smaller.
 *
 * So the third is the only correct option, and it carries a real cost: page
 * content, resources and annotations come across, but document-level structure
 * does not. See UNLOCK_CAVEATS — the UI states this rather than hiding it.
 */

import { loadPdfLib, openPdfDocument } from './pdflib.ts';

export { SourceEncrypted, inspectEncryption } from './pdflib.ts';
export type { Encryption } from './pdflib.ts';

/** What rebuilding the document cannot carry over. Shown to the visitor. */
export const UNLOCK_CAVEATS = [
  'Bookmarks and the document outline',
  'Form fields and any values in them',
  'File attachments and embedded JavaScript',
] as const;

export interface UnlockResult {
  bytes: Uint8Array;
  pages: number;
  /** Metadata fields that survived, for an honest summary afterwards. */
  keptMetadata: string[];
}

/**
 * Decrypts `bytes` and returns an unencrypted document.
 *
 * `password` may be omitted for an owner-only file, which opens without one —
 * that case is "remove restrictions" rather than "remove a password".
 */
export async function unlockPdf(bytes: Uint8Array, password?: string): Promise<UnlockResult> {
  const { PDFDocument } = await loadPdfLib();

  const source = await openPdfDocument(bytes, password);
  const target = await PDFDocument.create();

  const copied = await target.copyPages(source, source.getPageIndices());
  for (const page of copied) target.addPage(page);

  // Best-effort metadata carry-over. Encrypted documents often expose nothing
  // here — the fields read as undefined — so each one is copied only if present
  // and the caller is told what actually survived.
  const kept: string[] = [];
  const fields: [string, () => string | undefined, (v: string) => void][] = [
    ['Title', () => source.getTitle(), (v) => target.setTitle(v)],
    ['Author', () => source.getAuthor(), (v) => target.setAuthor(v)],
    ['Subject', () => source.getSubject(), (v) => target.setSubject(v)],
    ['Keywords', () => source.getKeywords(), (v) => target.setKeywords([v])],
    ['Creator', () => source.getCreator(), (v) => target.setCreator(v)],
  ];
  for (const [label, get, set] of fields) {
    let value: string | undefined;
    try {
      value = get();
    } catch {
      // A malformed Info dictionary should not sink the whole unlock.
      value = undefined;
    }
    if (value) {
      set(value);
      kept.push(label);
    }
  }
  target.setProducer('nikhilkhilwani.github.io/tools/unlock-pdf');

  return {
    bytes: await target.save(),
    pages: target.getPageCount(),
    keptMetadata: kept,
  };
}
