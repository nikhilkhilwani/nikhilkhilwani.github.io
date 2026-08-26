/**
 * PDF security verification. Runs in plain Node — no browser, no new
 * dependencies — so it can gate every push.
 *
 * Two things make this worth having in CI rather than as a local check:
 *
 *   1. It verifies our output with pdf.js, an INDEPENDENT implementation.
 *      @cantoo/pdf-lib agreeing with itself proves nothing about whether a real
 *      reader treats the file as encrypted.
 *
 *   2. classifyPasswordError() matches on the literal strings "Password
 *      incorrect" and "NEEDS PASSWORD" thrown by @cantoo/pdf-lib, because it
 *      exposes a dedicated error class for only one of the three cases. If an
 *      upgrade rewords them, both PDF security tools silently misreport
 *      passwords. Nothing else in the suite would notice. These assertions are
 *      the tripwire.
 *
 * Run with `npm test`.
 */

import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { protectPdf, classifyPasswordError, inspectEncryption } from '../src/lib/pdf/protect.ts';
import { unlockPdf } from '../src/lib/pdf/unlock.ts';
import { OPEN_PERMISSIONS } from '../src/lib/pdf/protect.ts';

let fail = 0;
let pass = 0;
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    console.log(`FAIL ${msg}`);
    fail++;
  }
};
const eq = (a, b, msg) => {
  if (a === b) pass++;
  else {
    console.log(`FAIL ${msg}\n       got:  ${JSON.stringify(a)}\n       want: ${JSON.stringify(b)}`);
    fail++;
  }
};

/* ------------------------------------------------------------- fixtures */

const SECRET = 'Confidential clause';

async function makePlain(pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    doc.addPage([320, 240]).drawText(`${SECRET} ${n}`, { x: 28, y: 190, size: 15, font });
  }
  return doc.save();
}

async function encrypt(plain, options) {
  const doc = await PDFDocument.load(plain);
  doc.encrypt({ algorithm: 'AES-256', ...options });
  return doc.save();
}

/** Opens with pdf.js and reports exactly how it reacted. */
async function read(bytes, password) {
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      password,
      isEvalSupported: false,
    }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items
      .map((i) => i.str)
      .join('');
    return { opened: true, pages: doc.numPages, text };
  } catch (err) {
    return { opened: false, name: err?.name, code: err?.code };
  }
}

const declaresEncrypt = (bytes) =>
  /\/Encrypt\s+\d+\s+\d+\s+R/.test(Buffer.from(bytes).toString('latin1'));

const plain = await makePlain();

/* ------------------------------------------------- 1. protect: AES-256 */

{
  const out = await protectPdf({
    bytes: plain,
    userPassword: 'open-sesame',
    ownerPassword: 'owner-key',
    cipher: 'AES-256',
    permissions: { ...OPEN_PERMISSIONS, copying: false },
  });
  const raw = Buffer.from(out).toString('latin1');

  eq(Buffer.from(out.subarray(0, 5)).toString(), '%PDF-', 'protect: output has a PDF header');
  ok(declaresEncrypt(out), 'protect: trailer declares /Encrypt');
  ok(raw.includes('/AESV3'), 'protect: AES-256 writes AESV3');
  ok(!raw.includes(`${SECRET} 1`), 'protect: page text is not left in plaintext');

  // Independent verification.
  const none = await read(out);
  ok(!none.opened && none.name === 'PasswordException', 'protect: pdf.js refuses it without a password');
  eq(none.code, 1, 'protect: pdf.js reports "password needed"');

  const wrong = await read(out, 'not-it');
  eq(wrong.code, 2, 'protect: pdf.js reports "incorrect password"');

  const right = await read(out, 'open-sesame');
  ok(right.opened, 'protect: pdf.js opens it with the user password');
  eq(right.pages, 3, 'protect: page count survives');
  ok(right.text.includes(`${SECRET} 1`), 'protect: text survives decryption');

  const owner = await read(out, 'owner-key');
  ok(owner.opened, 'protect: pdf.js opens it with the owner password too');
}

/* ------------------------------------------------- 2. protect: AES-128 */

{
  const out = await protectPdf({
    bytes: plain,
    userPassword: 'legacy-reader',
    cipher: 'AES-128',
    permissions: OPEN_PERMISSIONS,
  });
  ok(Buffer.from(out).toString('latin1').includes('/AESV2'), 'protect: AES-128 writes AESV2');
  const r = await read(out, 'legacy-reader');
  ok(r.opened && r.pages === 3, 'protect: AES-128 output opens with its password');
}

/* --------------------------------- 3. protect: owner-only restriction */

{
  const out = await protectPdf({
    bytes: plain,
    ownerPassword: 'owner-key',
    cipher: 'AES-256',
    permissions: { ...OPEN_PERMISSIONS, printing: false, copying: false },
  });
  ok(declaresEncrypt(out), 'protect: owner-only output still declares /Encrypt');
  const anyone = await read(out);
  ok(anyone.opened, 'protect: owner-only output opens with no password');
  eq(anyone.pages, 3, 'protect: owner-only page count intact');
}

/* ------------------------- 4. protect refuses a request with no password */

{
  let threw = false;
  try {
    await protectPdf({ bytes: plain, cipher: 'AES-256', permissions: OPEN_PERMISSIONS });
  } catch {
    threw = true;
  }
  ok(threw, 'protect: refuses to encrypt with neither password set');
}

/* ------------- 5. the tripwire: third-party error strings still classify */

{
  const userPw = await encrypt(plain, { userPassword: 'right-pw' });

  const attempt = async (options) => {
    try {
      await PDFDocument.load(userPw, options);
      return null;
    } catch (err) {
      return err;
    }
  };

  const noPassword = await attempt(undefined);
  ok(noPassword, 'classify: loading an encrypted file with no password throws');
  eq(await classifyPasswordError(noPassword), 'needs-password', 'classify: no password -> needs-password');

  const wrongPassword = await attempt({ password: 'wrong-pw' });
  ok(wrongPassword, 'classify: a wrong password throws');
  eq(
    await classifyPasswordError(wrongPassword),
    'wrong-password',
    'classify: wrong password -> wrong-password (matches the library message)',
  );

  const emptyPassword = await attempt({ password: '' });
  ok(emptyPassword, 'classify: an empty password on a user-password file throws');
  eq(
    await classifyPasswordError(emptyPassword),
    'needs-password',
    'classify: empty password -> needs-password',
  );

  eq(await classifyPasswordError(new Error('disk on fire')), null, 'classify: unrelated errors are not password problems');
  eq(await classifyPasswordError('not an error'), null, 'classify: a non-Error is not a password problem');
}

/* -------------------------- 6. inspectEncryption: the three input shapes */

{
  eq(await inspectEncryption(plain), 'none', 'inspect: an unencrypted file reads as none');
  eq(
    await inspectEncryption(await encrypt(plain, { userPassword: 'pw' })),
    'user-password',
    'inspect: a user-password file reads as user-password',
  );
  eq(
    await inspectEncryption(await encrypt(plain, { ownerPassword: 'pw', permissions: { copying: false } })),
    'owner-only',
    'inspect: an owner-only file reads as owner-only',
  );
}

/* ------------------------------------------------------------ 7. unlock */

{
  const locked = await encrypt(plain, { userPassword: 'let-me-in' });
  const result = await unlockPdf(locked, 'let-me-in');

  eq(result.pages, 3, 'unlock: page count survives');
  // The defect the naive strategy had: /Encrypt surviving in the xref dict.
  ok(!declaresEncrypt(result.bytes), 'unlock: output does NOT declare /Encrypt');

  let reopened = true;
  try {
    await PDFDocument.load(result.bytes);
  } catch {
    reopened = false;
  }
  ok(reopened, 'unlock: @cantoo/pdf-lib reopens its own output');

  const anyone = await read(result.bytes);
  ok(anyone.opened, 'unlock: pdf.js opens it with no password');
  eq(anyone.pages, 3, 'unlock: pdf.js sees all pages');
  ok(anyone.text.includes(`${SECRET} 1`), 'unlock: text survives the rebuild');
  ok(Array.isArray(result.keptMetadata), 'unlock: reports which metadata survived');
}

/* ------------------------------------------- 8. unlock: owner-only input */

{
  const restricted = await encrypt(plain, {
    ownerPassword: 'owner-key',
    permissions: { copying: false, printing: false },
  });
  // No password: an owner-only file opens on an empty one.
  const result = await unlockPdf(restricted);
  ok(!declaresEncrypt(result.bytes), 'unlock: owner-only output has no /Encrypt');
  eq(result.pages, 3, 'unlock: owner-only page count intact');
  const anyone = await read(result.bytes);
  ok(anyone.opened && anyone.text.includes(`${SECRET} 1`), 'unlock: owner-only text intact');
}

/* ----------------------------- 9. unlock rejects the wrong password */

{
  const locked = await encrypt(plain, { userPassword: 'correct' });
  let name = null;
  try {
    await unlockPdf(locked, 'incorrect');
  } catch (err) {
    name = err?.name;
  }
  eq(name, 'SourceEncrypted', 'unlock: a wrong password raises SourceEncrypted');
}

/* --------------------------- 10. round trip: protect then unlock */

{
  const locked = await protectPdf({
    bytes: plain,
    userPassword: 'round-trip',
    cipher: 'AES-256',
    permissions: OPEN_PERMISSIONS,
  });
  const opened = await unlockPdf(locked, 'round-trip');
  const anyone = await read(opened.bytes);
  ok(anyone.opened, 'round trip: protect then unlock yields a readable file');
  eq(anyone.pages, 3, 'round trip: pages intact');
  ok(anyone.text.includes(`${SECRET} 1`), 'round trip: text intact');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
