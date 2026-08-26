/**
 * PDF password protection, via @cantoo/pdf-lib — a maintained MIT fork of
 * pdf-lib that adds real encryption. No WASM: an earlier plan assumed qpdf
 * compiled to WebAssembly plus a crossOriginIsolated shim, and neither is
 * needed.
 *
 * Verified against pdf.js (an independent implementation): AES-256 output is
 * refused without a password, refused with a wrong one, and opens with either
 * the user or the owner password.
 *
 * Opening and password classification live in ./pdflib, shared with unlock —
 * see the measured behaviour table there.
 *
 * passwordStrength() is pure and covered by scripts/test-tools.mjs.
 */

import { openPdfDocument, SourceEncrypted } from './pdflib.ts';

// Re-exported so pages can import the whole PDF-security surface from here.
export { SourceEncrypted, loadPdfLib, classifyPasswordError, inspectEncryption, openPdfDocument } from './pdflib.ts';
export type { Encryption } from './pdflib.ts';

export type Cipher = 'AES-256' | 'AES-128';

export const CIPHERS: { id: Cipher; label: string; hint: string }[] = [
  { id: 'AES-256', label: 'AES-256', hint: 'Strongest. Needs Acrobat 9 or newer — effectively everything current.' },
  { id: 'AES-128', label: 'AES-128', hint: 'For very old readers. Still sound, but prefer AES-256.' },
];

/** Mirrors @cantoo/pdf-lib's UserPermissions, minus the axes it does not model. */
export interface Permissions {
  /** false blocks printing entirely; 'lowResolution' allows a degraded print. */
  printing: 'highResolution' | 'lowResolution' | false;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
}

export const OPEN_PERMISSIONS: Permissions = {
  printing: 'highResolution',
  modifying: true,
  copying: true,
  annotating: true,
  fillingForms: true,
};

/** AES key generation needs a real CSPRNG, which insecure origins do not expose. */
export class NoSecureRandom extends Error {
  constructor() {
    super('Encryption needs a secure context (https). This page is not running on one.');
    this.name = 'NoSecureRandom';
  }
}

export const hasSecureRandom = (): boolean =>
  typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';

export interface ProtectRequest {
  bytes: Uint8Array;
  /** Required to open the result. Omit for owner-only restriction. */
  userPassword?: string;
  /** Grants full access and is what a reader checks before enforcing limits. */
  ownerPassword?: string;
  cipher: Cipher;
  permissions: Permissions;
  /** Only needed when the source file is already encrypted. */
  sourcePassword?: string;
}

/**
 * Encrypts `bytes` and returns the new document.
 *
 * A PDF with an owner password but no user password opens for anyone while
 * still declaring its permission limits — "restrict", rather than "lock".
 */
export async function protectPdf({
  bytes,
  userPassword,
  ownerPassword,
  cipher,
  permissions,
  sourcePassword,
}: ProtectRequest): Promise<Uint8Array> {
  if (!hasSecureRandom()) throw new NoSecureRandom();
  if (!userPassword && !ownerPassword) {
    throw new Error('Set a password to open the file, an owner password, or both');
  }

  // openPdfDocument handles owner-only files, which need an empty-string
  // password rather than none — loadForProtect used to mis-handle those.
  const doc = await openPdfDocument(bytes, sourcePassword);

  doc.encrypt({
    ...(userPassword ? { userPassword } : {}),
    ...(ownerPassword ? { ownerPassword } : {}),
    algorithm: cipher,
    permissions: {
      printing: permissions.printing === false ? undefined : permissions.printing,
      modifying: permissions.modifying,
      copying: permissions.copying,
      annotating: permissions.annotating,
      fillingForms: permissions.fillingForms,
    },
  });

  return doc.save();
}

/* ------------------------------------------------------------- strength */

export interface Strength {
  /** 0 (unusable) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

/**
 * A deliberately simple, explainable estimate: length carries most of the
 * weight, character variety the rest. It is guidance for a human, not an
 * entropy claim — anything that pretends to measure entropy from one string is
 * lying, and a long passphrase of lowercase words beats a short mangled word.
 */
export function passwordStrength(password: string): Strength {
  if (!password) {
    return { score: 0, label: 'Empty', hint: 'Anyone can open the file.' };
  }
  if (password.length < 6) {
    return { score: 0, label: 'Too short', hint: 'Use at least 8 characters.' };
  }

  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);

  // Length bands, then a nudge for variety. A 20-character passphrase reaches
  // the top band on length alone, which is the behaviour we want to encourage.
  let score = password.length >= 20 ? 4 : password.length >= 14 ? 3 : password.length >= 10 ? 2 : 1;
  if (classes >= 3 && score < 4) score += 1;
  // Single-class is only penalised while the password is also short. Docking a
  // 25-character all-lowercase passphrase would contradict the whole premise
  // above — that one is genuinely strong.
  if (classes === 1 && password.length < 16 && score > 1) score -= 1;

  const bounded = Math.max(0, Math.min(4, score)) as Strength['score'];
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  // Rendered as "{label} — {hint}", so a hint must never restate its label.
  const hints = [
    'Trivially guessable.',
    'Add length — a short phrase beats a mangled word.',
    'More length helps more than more symbols.',
    'A few more words would make it strong.',
    'Store it somewhere you will not lose it.',
  ];
  return { score: bounded, label: labels[bounded], hint: hints[bounded] };
}

/** Human summary of what a reader will and will not allow. */
export function describePermissions(p: Permissions): string {
  const off: string[] = [];
  if (p.printing === false) off.push('printing');
  else if (p.printing === 'lowResolution') off.push('high-quality printing');
  if (!p.copying) off.push('copying text');
  if (!p.modifying) off.push('editing');
  if (!p.annotating) off.push('commenting');
  if (!p.fillingForms) off.push('filling forms');

  if (!off.length) return 'No restrictions — the password is only needed to open the file.';
  const list =
    off.length === 1 ? off[0] : `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}`;
  return `Readers that honour permissions will block ${list}.`;
}
