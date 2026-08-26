/**
 * Shared @cantoo/pdf-lib access for the PDF security tools.
 *
 * The library's behaviour across the three encryption shapes is not obvious, so
 * it was measured rather than assumed (@cantoo/pdf-lib 2.9.1):
 *
 *                    | load() bare        | load({password:''}) | ignoreEncryption
 *   not encrypted    | opens              | opens               | opens
 *   user password    | EncryptedPDFError  | Error NEEDS PASSWORD| opens, streams UNDECRYPTED
 *   owner-only       | EncryptedPDFError  | OPENS, isEncrypted=0| opens, streams UNDECRYPTED
 *
 * Two consequences drive this module:
 *
 *   - An owner-only file (opens freely in any reader, but carries permission
 *     limits) needs an EMPTY-STRING password, not no password. Treating '' as
 *     absent makes such a file look like it needs a password nobody has.
 *   - `ignoreEncryption: true` loads the structure but leaves content streams
 *     encrypted, so extracted text comes out empty. It must never be used to
 *     read a document, only to inspect one.
 */

export type Encryption = 'none' | 'owner-only' | 'user-password';

/** Loaded once per page; ~430 kB, so never at import time. */
let cached: Promise<typeof import('@cantoo/pdf-lib')> | null = null;
export function loadPdfLib(): Promise<typeof import('@cantoo/pdf-lib')> {
  cached ??= import('@cantoo/pdf-lib');
  return cached;
}

/** The document needs a password we do not have (or the one given was wrong). */
export class SourceEncrypted extends Error {
  /** true when a password was supplied and rejected, false when none was given. */
  readonly wrong: boolean;

  // A field plus an assignment rather than a constructor parameter property:
  // the latter is TypeScript-only syntax that Node's type stripping refuses,
  // which would break the unit tests importing this module directly.
  constructor(wrong: boolean) {
    super(wrong ? 'That password did not open the file' : 'This PDF is password-protected');
    this.wrong = wrong;
    this.name = 'SourceEncrypted';
  }
}

/**
 * Classifies a load failure as a password problem.
 *
 * The library gives a dedicated class for only one case:
 *   no password given  -> EncryptedPDFError
 *   wrong password     -> bare Error, message "Password incorrect"
 *   empty-string pass  -> bare Error, message "NEEDS PASSWORD"
 *
 * Matching on message text is fragile, so it is confined to this one function:
 * if the library rewords those strings, this is the only place to fix.
 */
export async function classifyPasswordError(
  err: unknown,
): Promise<'needs-password' | 'wrong-password' | null> {
  const { EncryptedPDFError } = await loadPdfLib();
  if (err instanceof EncryptedPDFError) return 'needs-password';

  const message = err instanceof Error ? err.message : '';
  if (/password\s+incorrect/i.test(message)) return 'wrong-password';
  if (/needs\s+password/i.test(message)) return 'needs-password';
  return null;
}

/**
 * Opens a document for reading, decrypting it properly.
 *
 * With no password: tries a plain load, then an empty-string password, which is
 * what an owner-only file wants. Throws SourceEncrypted when a real password is
 * needed or the supplied one is refused.
 */
export async function openPdfDocument(bytes: Uint8Array, password?: string) {
  const { PDFDocument } = await loadPdfLib();

  if (password) {
    try {
      return await PDFDocument.load(bytes, { password });
    } catch (err) {
      const kind = await classifyPasswordError(err);
      if (kind) throw new SourceEncrypted(true);
      throw err;
    }
  }

  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    const kind = await classifyPasswordError(err);
    if (!kind) throw err;

    // Encrypted. It may still be owner-only, which opens on an empty password.
    try {
      return await PDFDocument.load(bytes, { password: '' });
    } catch {
      throw new SourceEncrypted(false);
    }
  }
}

/**
 * Reports which of the three shapes `bytes` is, without needing a password.
 *
 * Used to tell "nothing to remove" from "needs a password" from "opens, but
 * restricted" before asking the visitor for anything.
 */
export async function inspectEncryption(bytes: Uint8Array): Promise<Encryption> {
  const { PDFDocument } = await loadPdfLib();

  try {
    await PDFDocument.load(bytes);
    return 'none';
  } catch (err) {
    if (!(await classifyPasswordError(err))) throw err;
  }

  try {
    await PDFDocument.load(bytes, { password: '' });
    return 'owner-only';
  } catch {
    return 'user-password';
  }
}
