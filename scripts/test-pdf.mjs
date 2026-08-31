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
import { recompressImages, flattenToImages, percentSaved, estimateRecompress, describeEstimate } from '../src/lib/pdf/compress.ts';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { docxToPdf as docxToPdfRaw, describeConversion, looksLikeDocx } from '../src/lib/docx/topdf.ts';
import { readFile as readFileFs } from 'node:fs/promises';
import { join as joinPath } from 'node:path';

/**
 * The converter fetches /fonts/*.ttf in the browser, which cannot work here —
 * without this every docx test would quietly fall back to the built-in fonts
 * and the metric-compatible path, the whole point of fonts.ts, would go
 * completely untested in CI. Reading the same committed files off disk means
 * every existing assertion below exercises the real embedding path.
 */
const nodeFontSource = async (file) =>
  new Uint8Array(await readFileFs(joinPath(process.cwd(), 'public', 'fonts', file)));

const docxToPdf = (input, opts = {}) => docxToPdfRaw(input, { fontSource: nodeFontSource, ...opts });

/** Same reader, but records every file requested. */
function trackingFontSource() {
  const asked = [];
  const source = async (file) => {
    asked.push(file);
    return nodeFontSource(file);
  };
  source.asked = asked;
  return source;
}
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


/* ------------------------------- 11. compress: recompression keeps the text */

{
  // A photographic JPEG, big enough that recompressing it clearly pays.
  const photo = await sharp({
    create: { width: 1400, height: 1000, channels: 3, background: { r: 30, g: 80, b: 110 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 700, height: 500, channels: 3, background: { r: 210, g: 130, b: 40 } },
        })
          .png()
          .toBuffer(),
        top: 120,
        left: 250,
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();

  const withImages = await PDFDocument.create();
  const font = await withImages.embedFont(StandardFonts.Helvetica);
  const embedded = await withImages.embedJpg(photo);
  for (let n = 1; n <= 2; n++) {
    const page = withImages.addPage([595, 842]);
    page.drawImage(embedded, { x: 40, y: 420, width: 515, height: 368 });
    page.drawText(`${SECRET} ${n}`, { x: 40, y: 360, size: 15, font });
  }
  const source = await withImages.save();

  // sharp stands in for the browser's canvas. Injecting the encoder is what
  // lets this run in CI at all.
  const encode = async (input, { quality, maxEdge }) => {
    let pipeline = sharp(Buffer.from(input));
    if (maxEdge) {
      pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    }
    const buf = await pipeline.jpeg({ quality: Math.round(quality * 100) }).toBuffer();
    const meta = await sharp(buf).metadata();
    return { bytes: new Uint8Array(buf), width: meta.width, height: meta.height };
  };

  const { bytes: out, report } = await recompressImages(source, {
    quality: 0.5,
    maxEdge: 900,
    encode,
  });

  eq(report.touched, 1, 'compress: the one embedded image was recompressed');
  ok(report.textPreserved, 'compress: recompression reports text as preserved');
  ok(out.length < source.length, `compress: output is smaller (${source.length} -> ${out.length})`);
  ok(percentSaved(source.length, out.length) > 0, 'compress: a real saving was made');

  // The whole promise of this mode: identical text before and after.
  const before = await read(source);
  const after = await read(out);
  ok(before.opened && after.opened, 'compress: both documents open');
  eq(after.pages, before.pages, 'compress: page count unchanged');
  eq(after.text, before.text, 'compress: extracted text is BYTE-IDENTICAL after recompression');
  ok(after.text.includes(`${SECRET} 1`), 'compress: the text is actually there');
}

/* ------------------------- 12. compress: what it refuses to touch */

{
  // A PNG becomes a FlateDecode stream, which this mode leaves alone.
  const png = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 10, g: 200, b: 150, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

  const doc = await PDFDocument.create();
  const embedded = await doc.embedPng(png);
  doc.addPage([400, 300]).drawImage(embedded, { x: 0, y: 0, width: 400, height: 300 });
  const source = await doc.save();

  let called = 0;
  const { report } = await recompressImages(source, {
    quality: 0.5,
    maxEdge: null,
    encode: async () => {
      called++;
      return null;
    },
  });
  eq(report.touched, 0, 'compress: a lossless image is not recompressed');
  eq(called, 0, 'compress: the encoder is never even invoked for it');
  ok(
    (report.skipped['not a JPEG'] ?? 0) + (report.skipped.transparency ?? 0) > 0,
    `compress: it is reported as skipped (${JSON.stringify(report.skipped)})`,
  );
}

/* ------------------- 13. compress: an encoder that grows the file is ignored */

{
  // Gaussian noise, not a flat colour: a flat 900x700 JPEG compresses to about
  // 4 kB, which lands under the "already small" floor and would be skipped
  // before the encoder is ever consulted — testing nothing.
  const photo = await sharp({
    create: {
      width: 900,
      height: 700,
      channels: 3,
      background: { r: 90, g: 40, b: 120 },
      noise: { type: 'gaussian', mean: 128, sigma: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const doc = await PDFDocument.create();
  const embedded = await doc.embedJpg(photo);
  doc.addPage([600, 400]).drawImage(embedded, { x: 0, y: 0, width: 600, height: 400 });
  const source = await doc.save();

  const { bytes: out, report } = await recompressImages(source, {
    quality: 1,
    maxEdge: null,
    // Deliberately returns something larger than the input.
    encode: async (input) => ({ bytes: new Uint8Array(input.length + 5000), width: 900, height: 700 }),
  });
  eq(report.touched, 0, 'compress: a larger result is rejected');
  eq(report.skipped['no gain'], 1, 'compress: and reported as "no gain"');
  ok(out.length <= source.length + 2048, 'compress: the file did not balloon');
}

/* ---------------------------- 14. compress: flatten rebuilds from images */

{
  const rendered = await sharp({
    create: { width: 600, height: 800, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .jpeg({ quality: 60 })
    .toBuffer();

  const { bytes: out, report } = await flattenToImages(50_000, {
    pages: [
      { number: 1, width: 595, height: 842 },
      { number: 2, width: 595, height: 842 },
    ],
    renderPage: async () => ({ bytes: new Uint8Array(rendered), width: 600, height: 800 }),
  });

  ok(!report.textPreserved, 'flatten: reports that text is NOT preserved');
  eq(report.touched, 2, 'flatten: both pages were rebuilt');
  const r = await read(out);
  ok(r.opened, 'flatten: output opens');
  eq(r.pages, 2, 'flatten: page count matches');
  eq(r.text.trim(), '', 'flatten: no extractable text remains, as advertised');

  // Page geometry must survive so the result still prints at the right size.
  const check = await PDFDocument.load(out);
  const size = check.getPage(0).getSize();
  ok(
    Math.abs(size.width - 595) < 1 && Math.abs(size.height - 842) < 1,
    `flatten: page size preserved in points (${size.width.toFixed(0)}x${size.height.toFixed(0)})`,
  );
}


/* ------------------------------- 15. word to pdf: the whole pipeline */

{
  const build = (bodyXml) => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
 <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
    // A real numbering definition, without which mammoth cannot emit lists.
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="."/></w:lvl></w:abstractNum>
 <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
 <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
 <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;
    return zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rootRels),
      'word/document.xml': strToU8(documentXml),
      'word/_rels/document.xml.rels': strToU8(docRels),
      'word/numbering.xml': strToU8(numbering),
      'word/styles.xml': strToU8(styles),
    });
  };

  const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const li = (text, numId) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

  const rich = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Nikhil Khilwani</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t xml:space="preserve">Accents: José Müller Ståle. </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Bold here.</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> Italic here.</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Experience</w:t></w:r></w:p>`,
    li('Built a data platform', 1),
    li('Ran the migration', 1),
    li('First numbered step', 2),
    li('Second numbered step', 2),
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Growth</w:t></w:r></w:p></w:tc></w:tr>`,
    `<w:tr><w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Nineteen percent, a value long enough to wrap inside its own column</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  ].join('');

  const docx = build(rich);
  ok(looksLikeDocx(docx), 'word: the fixture is recognised as a .docx');

  const result = await docxToPdf(docx);
  eq(result.unsupported.length, 0, 'word: no unsupported characters in a Latin document');
  ok(result.blocks >= 8, `word: parsed ${result.blocks} blocks`);
  ok(result.pages >= 1, `word: produced ${result.pages} page(s)`);

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false }).promise;
  let text = '';
  for (let n = 1; n <= pdf.numPages; n++) {
    text += (await (await pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + ' ';
  }

  ok(text.includes('Nikhil Khilwani'), 'word: the heading is selectable text, not an image');
  ok(text.includes('José') && text.includes('Müller'), 'word: Latin-1 accents survive');
  ok(text.includes('Bold here'), 'word: a bold run keeps its text');
  ok(text.includes('Italic here'), 'word: an italic run keeps its text');
  ok(text.includes('Experience'), 'word: the second-level heading is present');
  ok(text.includes('Built a data platform'), 'word: bullet list content is present');
  ok(/1\./.test(text) && /2\./.test(text), 'word: numbered list markers are drawn');
  ok(text.includes('Region') && text.includes('Growth'), 'word: table header cells are present');
  ok(text.includes('Nineteen percent'), 'word: a wrapped table cell keeps its text');

  /* --- pagination: the part that fails silently --- */

  const many = Array.from({ length: 90 }, (_, i) =>
    p(`Paragraph number ${i + 1} exists to make this document long enough that the layout has to break it across several pages, which is exactly the behaviour worth checking.`),
  ).join('');
  const long = await docxToPdf(build(many));
  ok(long.pages > 1, `word: a long document paginates (${long.pages} pages)`);

  const longPdf = await pdfjs.getDocument({ data: new Uint8Array(long.bytes), isEvalSupported: false }).promise;
  let all = '';
  for (let n = 1; n <= longPdf.numPages; n++) {
    all += (await (await longPdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + ' ';
  }
  // Every paragraph must survive: losing content silently is the worst failure.
  const missing = [];
  for (let i = 1; i <= 90; i++) {
    if (!all.includes(`Paragraph number ${i} `)) missing.push(i);
  }
  eq(missing.length, 0, `word: all 90 paragraphs survive pagination${missing.length ? ` (missing ${missing.slice(0, 5)})` : ''}`);

  /* --- rejections --- */

  let rejected = null;
  try {
    await docxToPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  } catch (err) {
    rejected = err?.name;
  }
  eq(rejected, 'NotADocx', 'word: a PDF fed to the converter is rejected as not a .docx');

  let empty = null;
  try {
    await docxToPdf(build(''));
  } catch (err) {
    empty = err?.name;
  }
  eq(empty, 'NotADocx', 'word: an empty document is rejected rather than yielding a blank PDF');

  /* --- unsupported characters are reported, not dropped silently --- */

  // Devanagari used to be the example here. It renders properly now, so the
  // "reported honestly" path needs a script that genuinely has no font bundled:
  // CJK is not in SCRIPT_FONTS, so it still falls through to "?".
  const cjk = await docxToPdf(build(p('Hello and 中文日本語 together')));
  ok(cjk.unsupported.length > 0, `word: CJK is reported as undrawable (${cjk.unsupported.length} chars)`);
  ok(describeConversion(cjk).includes('could not be drawn'), 'word: the summary says so plainly');
  const cjkPdf = await pdfjs.getDocument({ data: new Uint8Array(cjk.bytes), isEvalSupported: false }).promise;
  const cjkText = (await (await cjkPdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  ok(cjkText.includes('Hello and'), 'word: the Latin part still renders alongside it');

  /* --- the metric-compatible fonts: prove the path is live, not falling back --- */

  // loadMetricFonts() returns null on any failure and the converter silently
  // uses the built-ins, so every assertion above would still pass with the new
  // code completely inert. This is the assertion that catches that.
  ok(result.metricFonts, 'word: Carlito was embedded, not the standard-14 fallback');

  // The font's own name table travels with the embedded program, so finding it
  // proves which typeface actually reached the page. Not matched as
  // "ABCDEF+Carlito": pdf-lib compresses the object streams, so the /BaseFont
  // entry carrying the subset tag is not visible in the raw bytes.
  const raw = Buffer.from(result.bytes).toString('latin1');
  ok(raw.includes('Carlito'), 'word: the embedded font program is Carlito');
  ok(!raw.includes('Times'), 'word: no standard-14 Times font was embedded alongside it');

  // subset:true is what keeps this small. Whole-font embedding measured 278KB
  // for ONE face and 2.5MB for four, so this ceiling is a real tripwire for
  // subsetting silently regressing.
  ok(
    result.bytes.length < 250_000,
    `word: subsetting keeps the PDF small (${(result.bytes.length / 1024).toFixed(0)}KB)`,
  );

  /* --- scripts that used to become "?" --- */

  const wide = await docxToPdf(
    build(p('Привет мир — Ελληνικά — Tiếng Việt — Łódź, Kraków, Gdańsk')),
  );
  eq(wide.unsupported.length, 0, 'word: Cyrillic, Greek, Vietnamese and Polish are all supported now');
  ok(wide.metricFonts, 'word: the wide-script document used the embedded font');
  const widePdf = await pdfjs.getDocument({ data: new Uint8Array(wide.bytes), isEvalSupported: false }).promise;
  const wideText = (await (await widePdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  ok(wideText.includes('Привет мир'), 'word: Cyrillic round-trips through the PDF as real text');
  ok(wideText.includes('Ελληνικά'), 'word: Greek round-trips through the PDF as real text');
  ok(wideText.includes('Tiếng Việt'), 'word: Vietnamese diacritics round-trip');
  ok(wideText.includes('Gdańsk'), 'word: Polish diacritics round-trip');

  /* --- extraction fidelity: the regression an embedded font can introduce --- */

  // Without subsetting, pdf-lib's ToUnicode table maps the "ti" ligature glyph
  // back to the wrong character and "Latin" extracts as "Laࢢn". Searchable text
  // is this tool's headline promise, so it gets an exact-match assertion.
  const ligatures = 'Latin notification ratification difficult affluent office shuffle';
  const lig = await docxToPdf(build(p(ligatures)));
  const ligPdf = await pdfjs.getDocument({ data: new Uint8Array(lig.bytes), isEvalSupported: false }).promise;
  const ligText = (await (await ligPdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  eq(ligText.trim(), ligatures, 'word: ligature-heavy text extracts back character-for-character');

  /* --- the fallback must still work when the fonts cannot be loaded --- */

  const offline = await docxToPdf(build(p('Fallback path with José')), {
    fontSource: async () => {
      throw new Error('no fonts here');
    },
  });
  eq(offline.metricFonts, false, 'word: an unreachable font falls back instead of throwing');
  ok(offline.pages >= 1, 'word: the fallback still produces a PDF');
  ok(
    describeConversion(offline).includes('metric-compatible fonts did not load'),
    'word: the summary admits the fallback rather than implying Word-matching output',
  );
  const offPdf = await pdfjs.getDocument({ data: new Uint8Array(offline.bytes), isEvalSupported: false }).promise;
  const offText = (await (await offPdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  ok(offText.includes('Fallback path'), 'word: the fallback output is still real text');

  /* --- complex scripts: Devanagari, and the fonts fetched to draw it --- */

  const HINDI = 'नमस्ते दुनिया। हिन्दी में लिखा गया वाक्य।';
  const trackHindi = trackingFontSource();
  const hi = await docxToPdf(build(p(`English then Hindi: ${HINDI}`)), { fontSource: trackHindi });

  eq(hi.unsupported.length, 0, 'word: Devanagari is fully drawable now, nothing became "?"');
  eq(hi.scripts.join(","), ['devanagari'].join(","), 'word: the result names Devanagari as rendered');
  eq(hi.scriptsMissing.join(","), "", 'word: no script font failed to load');
  eq(hi.rtl, false, 'word: Devanagari is not flagged right-to-left');

  // Lazy loading, per script: an English+Hindi document must not drag in Tamil.
  ok(
    trackHindi.asked.includes('NotoSansDevanagari.ttf'),
    `word: the Devanagari font was fetched (${trackHindi.asked.join(', ')})`,
  );
  ok(trackHindi.asked.includes('Carlito-Regular.ttf'), 'word: Carlito was fetched for the English part');
  ok(
    !trackHindi.asked.some((f) => /Tamil|Bengali|Arabic|Hebrew|Thai|Telugu|Kannada|Malayalam|Gujarati|Gurmukhi|Oriya/.test(f)),
    'word: no font for a script the document does not contain was fetched',
  );

  const hiPdf = await pdfjs.getDocument({ data: new Uint8Array(hi.bytes), isEvalSupported: false }).promise;
  const hiText = (await (await hiPdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  ok(hiText.includes('English then Hindi'), 'word: the English half is real text');
  // Devanagari extraction reflects VISUAL glyph order, because a reordered
  // matra is a different glyph — so assert on characters present rather than
  // on the original string.
  for (const ch of ['न', 'म', 'स', 'द', 'ह', '।']) {
    ok(hiText.includes(ch), `word: Devanagari "${ch}" survives into the PDF text layer`);
  }
  const rawHi = Buffer.from(hi.bytes).toString('latin1');
  ok(rawHi.includes('NotoSansDevanagari'), 'word: the Devanagari font program is embedded');
  ok(rawHi.includes('Carlito'), 'word: Carlito is embedded alongside it');
  ok(
    hi.bytes.length < 250_000,
    `word: two subsetted fonts stay small (${(hi.bytes.length / 1024).toFixed(0)}KB)`,
  );

  /* --- several scripts at once --- */

  const multi = await docxToPdf(
    build(
      p('Hindi: नमस्ते') + p('Bengali: আমি') + p('Tamil: நான்') + p('Arabic: مرحبا'),
    ),
  );
  eq(multi.unsupported.length, 0, 'word: four scripts, nothing undrawable');
  eq(multi.scripts.length, 4, `word: all four scripts reported (${multi.scripts.join(', ')})`);
  eq(multi.rtl, true, 'word: the Arabic makes the result flag right-to-left');
  ok(
    describeConversion(multi).includes('logical order'),
    'word: the summary admits there is no bidi rather than implying correct RTL layout',
  );

  /* --- a script font that cannot be loaded is reported, not silently wrong --- */

  const noDev = await docxToPdf(build(p(`Hindi ${HINDI}`)), {
    fontSource: async (file) => {
      if (file.includes('Devanagari')) throw new Error('unavailable');
      return nodeFontSource(file);
    },
  });
  eq(noDev.metricFonts, true, 'word: losing one script font does not lose Carlito');
  eq(noDev.scriptsMissing.join(","), ['devanagari'].join(","), 'word: the missing script is named');
  eq(noDev.scripts.join(","), "", 'word: and is not claimed as rendered');
  ok(noDev.unsupported.length > 0, 'word: its characters are reported as undrawable');
  ok(
    describeConversion(noDev).includes('Could not load a font'),
    'word: the summary says the font could not be loaded',
  );
  const ndPdf = await pdfjs.getDocument({ data: new Uint8Array(noDev.bytes), isEvalSupported: false }).promise;
  const ndText = (await (await ndPdf.getPage(1)).getTextContent()).items.map((i) => i.str).join('');
  ok(ndText.includes('Hindi'), 'word: the Latin part still converts when a script font is missing');

  /* --- image sizing: the bug that turned a 2-page resume into 8 pages --- */

  // Section dividers in resume templates are images 1pt tall. layout knew no
  // size and reserved the full text width at a hardcoded 4:3 ratio, so eight
  // rules cost four blank pages. This exercises the whole path: wp:extent read
  // from document.xml, correlated to mammoth's image blocks in order, then used
  // by layout.
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const EMU_PER_PT = 914400 / 72;
  const emu = (pt) => Math.round(pt * EMU_PER_PT);

  // An anchored drawing wrapped the way Word writes it, Fallback branch included,
  // so the de-duplication is exercised rather than assumed.
  const rule = (id, heightPt = 1) =>
    '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">' +
    `<w:drawing><wp:anchor><wp:extent cx="${emu(500)}" cy="${emu(heightPt)}"/>` +
    `<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
    '</wp:anchor></w:drawing></mc:Choice>' +
    `<mc:Fallback><w:drawing><wp:anchor><wp:extent cx="${emu(500)}" cy="${emu(400)}"/>` +
    `<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
    '</wp:anchor></w:drawing></mc:Fallback></mc:AlternateContent></w:r></w:p>';

  const RULES = 8;
  let ruleBody = '';
  for (let i = 0; i < RULES; i++) {
    ruleBody += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section ${i + 1}</w:t></w:r></w:p>`;
    ruleBody += rule(100 + i, i + 1);
    ruleBody += p(`Body text under section ${i + 1}.`);
  }

  const NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

  let rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (let i = 0; i < RULES; i++) {
    rels += `<Relationship Id="rId${100 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/rule.png"/>`;
  }
  rels += '</Relationships>';

  const withRules = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(rels),
    'word/media/rule.png': new Uint8Array(Buffer.from(PNG_1PX, 'base64')),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document ${NS}><w:body>${ruleBody}</w:body></w:document>`,
    ),
  });

  const ruled = await docxToPdf(withRules);
  ok(
    ruled.pages <= 2,
    `word: ${RULES} hairline divider rules do not inflate the page count (${ruled.pages} page(s))`,
  );

  // Each rule was declared 1pt taller than the last, so the sizes must come back
  // in that order. Equal sizes would let an off-by-one in the correlation pass
  // unnoticed, which is how the real resume hid one.
  eq(ruled.imageSizes.length, RULES, `word: a size was resolved for each of the ${RULES} images`);
  eq(
    ruled.imageSizes.map((z) => Math.round(z.height)).join(','),
    Array.from({ length: RULES }, (_, i) => i + 1).join(','),
    'word: image sizes line up with the images in document order, not shifted',
  );
  ok(
    ruled.imageSizes.every((z) => Math.abs(z.width - 500) < 0.5),
    'word: every rule kept its declared 500pt width',
  );

  const ruledPdf = await pdfjs.getDocument({ data: new Uint8Array(ruled.bytes), isEvalSupported: false }).promise;
  let ruledText = '';
  for (let n = 1; n <= ruledPdf.numPages; n++) {
    ruledText += (await (await ruledPdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + ' ';
  }
  for (let i = 1; i <= RULES; i++) {
    ok(ruledText.includes(`Section ${i}`), `word: section ${i} heading survived alongside the rules`);
  }
  ok(ruledText.includes(`Body text under section ${RULES}.`), 'word: the last paragraph is present');

  /* --- styles.xml, page breaks and vertical merges, end to end --- */

  // pdf.js reports each text item's size and position, so heading sizes and
  // column alignment can be asserted from the real output rather than inferred.
  const itemsOf = async (bytes) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      for (const it of content.items) {
        if (!it.str.trim()) continue;
        out.push({ page: n, str: it.str, size: it.height, x: it.transform[4], y: it.transform[5] });
      }
    }
    return out;
  };

  const styled = (docBody, stylesBody) =>
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/styles.xml': strToU8(
        `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${stylesBody}</w:styles>`,
      ),
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body>${docBody}</w:body></w:document>`,
      ),
    });

  /* styles.xml drives heading size */

  const HEAD_STYLES =
    '<w:style w:type="paragraph" w:styleId="Heading1">' +
    '<w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr></w:style>';

  const headed = await docxToPdf(
    styled(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>BIG HEADING</w:t></w:r></w:p>' +
        p('ordinary body text here'),
      HEAD_STYLES,
    ),
  );
  const headItems = await itemsOf(headed.bytes);
  const heading = headItems.find((i) => i.str.includes('BIG HEADING'));
  const body = headItems.find((i) => i.str.includes('ordinary body'));
  ok(heading !== undefined && body !== undefined, 'word: heading and body both rendered');
  ok(
    Math.abs(heading.size - 26) < 1.5,
    `word: the heading is drawn at the 26pt its style declares (got ${heading.size.toFixed(1)}pt)`,
  );
  ok(heading.size > body.size * 2, 'word: and is much larger than the body text');
  ok(heading.x > body.x + 20, `word: the style's centre alignment moved the heading right (${heading.x.toFixed(0)} vs ${body.x.toFixed(0)})`);

  // Without styles.xml the same document falls back to the built-in scale, so
  // the assertion above is really testing styles.xml and not a coincidence.
  const unstyledHead = await docxToPdf(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>BIG HEADING</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
  );
  const plainHeading = (await itemsOf(unstyledHead.bytes)).find((i) => i.str.includes('BIG HEADING'));
  ok(
    Math.abs(plainHeading.size - 26) > 3,
    `word: with no styles.xml the heading uses the built-in scale instead (${plainHeading.size.toFixed(1)}pt)`,
  );

  /* explicit page breaks */

  const noBreak = await docxToPdf(build(p('first') + p('second')));
  eq(noBreak.pages, 1, 'word: two short paragraphs share a page');

  const withBreak = await docxToPdf(
    build(p('first') + '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>second</w:t></w:r></w:p>'),
  );
  eq(withBreak.pages, 2, 'word: w:pageBreakBefore starts a new page');
  const breakItems = await itemsOf(withBreak.bytes);
  eq(breakItems.find((i) => i.str.includes('first')).page, 1, 'word: the first paragraph is on page 1');
  eq(breakItems.find((i) => i.str.includes('second')).page, 2, 'word: the second is on page 2');

  // The common authoring shape: a break alone in its own paragraph.
  const loneBreak = await docxToPdf(
    build(p('before') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + p('after')),
  );
  eq(loneBreak.pages, 2, 'word: a break in its own paragraph also starts a page');
  const loneItems = await itemsOf(loneBreak.bytes);
  eq(loneItems.find((i) => i.str.includes('before')).page, 1, 'word: content before the break stays on page 1');
  eq(loneItems.find((i) => i.str.includes('after')).page, 2, 'word: content after it moves to page 2');

  /* vertically merged cells */

  const merged = await docxToPdf(
    build(
      '<w:tbl>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>MERGEDCELL</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>ROWONE</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>' +
        '<w:tc><w:p><w:r><w:t>ROWTWO</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>THIRDA</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>THIRDB</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
  );
  const cells = await itemsOf(merged.bytes);
  const at = (needle) => cells.find((i) => i.str.includes(needle));
  for (const name of ['MERGEDCELL', 'ROWONE', 'ROWTWO', 'THIRDA', 'THIRDB']) {
    ok(at(name) !== undefined, `word: merged table kept "${name}"`);
  }
  // The continuation row has one <td>, which belongs in column 2. Without the
  // occupancy grid it would be drawn in column 1, under the merged cell.
  ok(
    Math.abs(at('ROWTWO').x - at('THIRDB').x) < 1,
    `word: the continuation cell sits in column 2 (${at('ROWTWO').x.toFixed(0)} vs ${at('THIRDB').x.toFixed(0)})`,
  );
  ok(
    at('ROWTWO').x > at('THIRDA').x + 20,
    'word: and not back in column 1 underneath the merged cell',
  );
  ok(
    Math.abs(at('MERGEDCELL').x - at('THIRDA').x) < 1,
    'word: the merged cell itself is in column 1',
  );

  /* --- run-level colour, highlighting and per-run sizes --- */

  // pdf.js reports every fill-colour operator as a hex string, so what actually
  // reached the page can be asserted rather than inferred from our own state.
  const fillsOf = async (bytes) => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    const found = new Set();
    for (let n = 1; n <= doc.numPages; n++) {
      const ops = await (await doc.getPage(n)).getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjs.OPS.setFillRGBColor) found.add(String(ops.argsArray[i][0]).toLowerCase());
      }
    }
    return found;
  };

  const painted = await docxToPdf(
    build(
      '<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>REDTEXT</w:t></w:r>' +
        '<w:r><w:t> plain </w:t></w:r>' +
        '<w:r><w:rPr><w:color w:val="0000FF"/></w:rPr><w:t>BLUETEXT</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>MARKED</w:t></w:r></w:p>',
    ),
  );
  eq(painted.runsStyled, 2, 'word: both paragraphs had their runs split for colour');

  const fills = await fillsOf(painted.bytes);
  ok(fills.has('#ff0000'), `word: red text reached the page (fills: ${[...fills].join(' ')})`);
  ok(fills.has('#0000ff'), 'word: blue text reached the page');
  ok(fills.has('#ffff00'), 'word: the yellow highlight was painted');
  ok(fills.size >= 4, 'word: the default ink is still used for unstyled text');

  // Both coloured stretches must survive as separate, readable text.
  const paintedItems = await itemsOf(painted.bytes);
  const joined = paintedItems.map((i) => i.str).join('');
  ok(joined.includes('REDTEXT'), 'word: the red run keeps its text');
  ok(joined.includes('BLUETEXT'), 'word: the blue run keeps its text');
  ok(joined.includes('plain'), 'word: the uncoloured run between them survives');
  ok(joined.includes('MARKED'), 'word: the highlighted run keeps its text');

  // A document with no colour at all must not start emitting colour operators.
  const plainFills = await fillsOf((await docxToPdf(build(p('just ordinary text')))).bytes);
  ok(!plainFills.has('#ff0000'), 'word: an uncoloured document paints no stray colours');

  /* per-run sizes: the caveat was that a paragraph took its first run's size */

  const mixedSize = await docxToPdf(
    build(
      '<w:p><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>SMALLRUN</w:t></w:r>' +
        '<w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:t>LARGERUN</w:t></w:r></w:p>',
    ),
  );
  const sizeItems = await itemsOf(mixedSize.bytes);
  const small = sizeItems.find((i) => i.str.includes('SMALLRUN'));
  const large = sizeItems.find((i) => i.str.includes('LARGERUN'));
  ok(small !== undefined && large !== undefined, 'word: both runs rendered');
  ok(Math.abs(small?.size - 8) < 1.5, `word: the 8pt run is drawn at 8pt (got ${small.size.toFixed(1)})`);
  ok(Math.abs(large?.size - 24) < 1.5, `word: the 24pt run is drawn at 24pt (got ${large.size.toFixed(1)})`);
  ok(large?.size > small?.size * 2, 'word: a paragraph mixing sizes no longer collapses to its first run');

  /* --- colour inside table cells --- */

  const cellColour = await docxToPdf(
    build(
      '<w:tbl>' +
        '<w:tr><w:tc><w:p><w:r><w:rPr><w:color w:val="1B2A49"/></w:rPr><w:t>NAVYLABEL</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>HILITECELL</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>PLAINCELL</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:rPr><w:sz w:val="30"/></w:rPr><w:t>BIGCELL</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
  );
  eq(cellColour.cellsStyled, 3, 'word: the three styled cells were split, the plain one left alone');

  const cellFills = await fillsOf(cellColour.bytes);
  ok(cellFills.has('#1b2a49'), `word: a navy table label reached the page (${[...cellFills].join(' ')})`);
  ok(cellFills.has('#ffff00'), 'word: a highlighted table cell was painted');

  const cellItems = await itemsOf(cellColour.bytes);
  const cellAt = (needle) => cellItems.find((i) => i.str.includes(needle));
  for (const name of ['NAVYLABEL', 'HILITECELL', 'PLAINCELL', 'BIGCELL']) {
    ok(cellAt(name) !== undefined, `word: cell "${name}" kept its text`);
  }
  ok(
    Math.abs(cellAt('BIGCELL').size - 15) < 1.5,
    `word: a cell run's own size is honoured (got ${cellAt('BIGCELL').size.toFixed(1)}pt)`,
  );
  ok(
    cellAt('BIGCELL').size > cellAt('PLAINCELL').size + 2,
    `word: and is larger than an ordinary cell (${cellAt('BIGCELL').size.toFixed(1)} vs ${cellAt('PLAINCELL').size.toFixed(1)})`,
  );

  // A vertical merge must not break the structural matching: mammoth omits the
  // continuation cell, so a naive pairing would shift every later cell.
  const mergedColour = await docxToPdf(
    build(
      '<w:tbl>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>SPANCELL</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>TOPRIGHT</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>' +
        '<w:tc><w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>REDCELL</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
  );
  eq(mergedColour.cellsStyled, 1, 'word: exactly the one coloured cell in a merged table was styled');
  const mergedFills = await fillsOf(mergedColour.bytes);
  ok(mergedFills.has('#ff0000'), 'word: and its colour landed, not on a neighbouring cell');
  const mergedItems = await itemsOf(mergedColour.bytes);
  for (const name of ['SPANCELL', 'TOPRIGHT', 'REDCELL']) {
    ok(mergedItems.some((i) => i.str.includes(name)), `word: merged table kept "${name}"`);
  }

  /* --- two-column sections --- */

  const filler = Array.from({ length: 24 }, (_, i) =>
    p(`Paragraph ${i + 1} carries enough words to wrap several times inside a narrow column, which is what makes the flow visible.`),
  ).join('');
  const sectPr = (cols) =>
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/>' +
    (cols ?? '') +
    '</w:sectPr>';

  const columned = await docxToPdf(build(filler + sectPr('<w:cols w:num="2" w:space="425"/>')));
  const singleCol = await docxToPdf(build(filler + sectPr(null)));

  eq(columned.pageSetup?.columns, 2, 'word: the section reports two columns');
  eq(singleCol.pageSetup?.columns, 1, 'word: and one without w:cols');

  const colItems = await itemsOf(columned.bytes);
  const onPage1 = colItems.filter((i) => i.page === 1).map((i) => Math.round(i.x));
  const distinct = [...new Set(onPage1)].sort((a, b) => a - b);
  ok(
    distinct.length >= 2,
    `word: page 1 of a two-column section draws at two left edges (${distinct.join(', ')})`,
  );
  ok(distinct[distinct.length - 1] > distinct[0] + 100, 'word: and those edges are a column apart');

  const plainItems = await itemsOf(singleCol.bytes);
  const plainX = [...new Set(plainItems.filter((i) => i.page === 1).map((i) => Math.round(i.x)))];
  eq(plainX.length, 1, `word: the same content in one column uses a single left edge (${plainX.join(', ')})`);

  // Not a page saving: a narrow column wraps about twice as often, so the two
  // arrangements are roughly even. What matters is that both columns are used.
  ok(
    columned.pages <= singleCol.pages,
    `word: two columns are no worse on page count (${columned.pages} vs ${singleCol.pages})`,
  );

  // Nothing may be lost to the column flow.
  const colText = colItems.map((i) => i.str).join(' ');
  const missingCol = [];
  for (let i = 1; i <= 24; i++) if (!colText.includes(`Paragraph ${i} `)) missingCol.push(i);
  eq(missingCol.length, 0, `word: every paragraph survives the column flow${missingCol.length ? ` (missing ${missingCol.slice(0, 4)})` : ''}`);

  /* --- headers, footers and page numbers --- */

  const NSW =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

  /** A package with a rels part plus whatever header/footer parts are given. */
  const withParts = (docBody, parts) =>
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      'word/_rels/document.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          Object.keys(parts)
            .map((name) => `<Relationship Id="rid_${name}" Type="x/${name}" Target="${name}.xml"/>`)
            .join('') +
          '</Relationships>',
      ),
      ...Object.fromEntries(
        Object.entries(parts).map(([name, xml]) => [`word/${name}.xml`, strToU8(`<?xml version="1.0"?>${xml}`)]),
      ),
      'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${NSW}><w:body>${docBody}</w:body></w:document>`),
    });

  const longBody = Array.from({ length: 55 }, (_, i) =>
    p(`Body paragraph ${i + 1} with enough words to push this document over several pages.`),
  ).join('');

  const sectWith = (refs) =>
    '<w:sectPr>' + refs +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134" w:header="567" w:footer="567"/>' +
    '</w:sectPr>';

  const HEADER =
    `<w:hdr ${NSW}><w:p>` +
    '<w:pPr><w:tabs><w:tab w:val="right" w:pos="9070"/></w:tabs></w:pPr>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>RUNNINGHEAD</w:t></w:r>' +
    '<w:r><w:tab/></w:r><w:r><w:t>RIGHTBIT</w:t></w:r></w:p></w:hdr>';

  const FOOTER =
    `<w:ftr ${NSW}><w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    '<w:r><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    '<w:r><w:t xml:space="preserve"> of </w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="begin"/><w:instrText> NUMPAGES </w:instrText>' +
    '<w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/></w:r>' +
    '</w:p></w:ftr>';

  const furnished = await docxToPdf(
    withParts(
      longBody +
        sectWith('<w:headerReference r:id="rid_header1" w:type="default"/><w:footerReference r:id="rid_footer1" w:type="default"/>'),
      { header1: HEADER, footer1: FOOTER },
    ),
  );

  eq(furnished.header, true, 'word: a header was found and drawn');
  eq(furnished.footer, true, 'word: a footer was found and drawn');
  ok(furnished.pages >= 2, `word: the furnished document runs to ${furnished.pages} pages`);

  const fItems = await itemsOf(furnished.bytes);

  // The header must repeat, and its page number must be right on every page.
  for (let n = 1; n <= furnished.pages; n++) {
    const onPage = fItems.filter((i) => i.page === n);
    ok(
      onPage.some((i) => i.str.includes('RUNNINGHEAD')),
      `word: the header repeats on page ${n}`,
    );
    ok(
      onPage.some((i) => i.str.includes('RIGHTBIT')),
      `word: its right-tabbed part is on page ${n} too`,
    );
    const joinedPage = onPage.map((i) => i.str).join('');
    ok(
      joinedPage.includes(`Page ${n} of ${furnished.pages}`),
      `word: page ${n} footer reads "Page ${n} of ${furnished.pages}"`,
    );
  }
  // The stale cached values must never appear.
  ok(!fItems.some((i) => i.str.includes('Page 1 of 1')), 'word: no cached "Page 1 of 1" leaked through');

  // The body must sit strictly between the bands, not over them.
  const page1 = fItems.filter((i) => i.page === 1);
  const headY = page1.find((i) => i.str.includes('RUNNINGHEAD')).y;
  const footY = page1.find((i) => i.str.includes('Page 1')).y;
  const bodyYs = page1.filter((i) => i.str.includes('Body paragraph')).map((i) => i.y);
  ok(bodyYs.length > 0, 'word: page 1 carries body text');
  ok(Math.max(...bodyYs) < headY, `word: the body starts below the header (${Math.max(...bodyYs).toFixed(0)} < ${headY.toFixed(0)})`);
  ok(Math.min(...bodyYs) > footY, `word: and stops above the footer (${Math.min(...bodyYs).toFixed(0)} > ${footY.toFixed(0)})`);

  /* the same document with margins too tight to clear the bands */

  // The case above has a 56.7pt top margin, which already sits below a 39.35pt
  // header — so the body never had to move and the overlap check passed for
  // free. This one squeezes the margins so the header and footer genuinely
  // intrude on the text area, which is what the insets exist for.
  const tightSect =
    '<w:sectPr>' +
    '<w:headerReference r:id="rid_header1" w:type="default"/>' +
    '<w:footerReference r:id="rid_footer1" w:type="default"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="284" w:bottom="284" w:left="1134" w:right="1134" w:header="283" w:footer="283"/>' +
    '</w:sectPr>';

  // Three lines deep, so the band reaches past where the body would otherwise
  // start. With a single-line header the body's own spaceBefore already clears
  // it and the check below would pass whether the insets worked or not.
  const TALL_HEADER =
    `<w:hdr ${NSW}>` +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>RUNNINGHEAD</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>HEADLINETWO</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>RIGHTBIT</w:t></w:r></w:p>' +
    '</w:hdr>';
  const TALL_FOOTER =
    `<w:ftr ${NSW}>` +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    '</w:p>' +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>FOOTLINETWO</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>FOOTLINETHREE</w:t></w:r></w:p>' +
    '</w:ftr>';

  const tight = await docxToPdf(
    withParts(longBody + tightSect, { header1: TALL_HEADER, footer1: TALL_FOOTER }),
  );
  eq(tight.header, true, 'word: the tight-margin document still finds its header');
  const tItems2 = await itemsOf(tight.bytes);
  const tPage1 = tItems2.filter((i) => i.page === 1);
  // The band's INNERMOST line is what the body has to clear, not its outermost.
  const tHead = tPage1.find((i) => i.str.includes('RIGHTBIT'));
  const tFoot = tPage1.find((i) => i.str.includes('Page 1'));
  const tBody = tPage1.filter((i) => i.str.includes('Body paragraph')).map((i) => i.y);
  ok(tHead !== undefined && tFoot !== undefined, 'word: tight margins still draw both bands');
  ok(tBody.length > 0, 'word: and still draw body text');
  ok(
    Math.max(...tBody) < tHead.y,
    `word: with tight margins the body is still pushed below the header (${Math.max(...tBody).toFixed(0)} < ${tHead.y.toFixed(0)})`,
  );
  ok(
    Math.min(...tBody) > tFoot.y,
    `word: and lifted above the footer (${Math.min(...tBody).toFixed(0)} > ${tFoot.y.toFixed(0)})`,
  );

  // Reserving the bands must cost page area, not overlap.
  const bare = await docxToPdf(withParts(longBody + sectWith(''), {}));
  eq(bare.header, false, 'word: a document with no header reports none');
  eq(bare.footer, false, 'word: and no footer');
  ok(
    furnished.pages >= bare.pages,
    `word: reserving the bands never yields more room (${furnished.pages} vs ${bare.pages})`,
  );

  /* different first page */

  const FIRST = `<w:hdr ${NSW}><w:p><w:r><w:t>TITLEPAGEHEAD</w:t></w:r></w:p></w:hdr>`;
  const titled = await docxToPdf(
    withParts(
      longBody +
        sectWith(
          '<w:titlePg/>' +
            '<w:headerReference r:id="rid_header1" w:type="default"/>' +
            '<w:headerReference r:id="rid_header2" w:type="first"/>',
        ),
      { header1: HEADER, header2: FIRST },
    ),
  );
  const tItems = await itemsOf(titled.bytes);
  const firstPage = tItems.filter((i) => i.page === 1).map((i) => i.str).join('');
  const laterPage = tItems.filter((i) => i.page === 2).map((i) => i.str).join('');
  ok(firstPage.includes('TITLEPAGEHEAD'), 'word: page 1 uses the first-page header');
  ok(!firstPage.includes('RUNNINGHEAD'), 'word: and not the default one');
  ok(laterPage.includes('RUNNINGHEAD'), 'word: page 2 uses the default header');
  ok(!laterPage.includes('TITLEPAGEHEAD'), 'word: and not the first-page one');
}


/* -------------- 16. compress: the estimate must match what actually happens */

{
  // Several noisy photos, so the sampling path and the arithmetic both matter.
  const photos = [];
  for (let i = 0; i < 3; i++) {
    photos.push(
      await sharp({
        create: {
          width: 1200 + i * 100,
          height: 900,
          channels: 3,
          background: { r: 40 + i * 30, g: 90, b: 120 },
          noise: { type: 'gaussian', mean: 128, sigma: 42 },
        },
      })
        .jpeg({ quality: 92 })
        .toBuffer(),
    );
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, photo] of photos.entries()) {
    const img = await doc.embedJpg(photo);
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 40, y: 420, width: 515, height: 380 });
    page.drawText(`${SECRET} ${i + 1}`, { x: 40, y: 360, size: 15, font });
  }
  const source = await doc.save();

  const encode = async (input, { quality, maxEdge }) => {
    let pipeline = sharp(Buffer.from(input));
    if (maxEdge) {
      pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    }
    const buf = await pipeline.jpeg({ quality: Math.round(quality * 100) }).toBuffer();
    const meta = await sharp(buf).metadata();
    return { bytes: new Uint8Array(buf), width: meta.width, height: meta.height };
  };

  const settings = { quality: 0.5, maxEdge: 900, encode };

  const predicted = await estimateRecompress(source, settings);
  const { bytes: actual, report } = await recompressImages(source, settings);

  eq(predicted.touched, report.touched, 'estimate: touches the same number of images as the real run');
  eq(predicted.sampled, false, 'estimate: three images is under the sampling limit');
  ok(predicted.after < predicted.before, 'estimate: predicts a smaller file');

  // The only thing the estimate cannot know is the xref the save rewrites, so
  // it should land within a few percent. A number that drifts further than that
  // is worse than showing nothing.
  const drift = Math.abs(predicted.after - actual.length) / actual.length;
  ok(drift < 0.05, `estimate: within 5% of the real result (${(drift * 100).toFixed(2)}% off)`);

  // Moving the quality dial must move the estimate in the right direction.
  const low = await estimateRecompress(source, { ...settings, quality: 0.3 });
  const high = await estimateRecompress(source, { ...settings, quality: 0.9 });
  ok(low.after < predicted.after, `estimate: lower quality predicts smaller (${low.after} < ${predicted.after})`);
  ok(high.after > predicted.after, `estimate: higher quality predicts larger (${high.after} > ${predicted.after})`);

  // And the resolution cap must matter too.
  const uncapped = await estimateRecompress(source, { ...settings, maxEdge: null });
  ok(uncapped.after > predicted.after, 'estimate: keeping full resolution predicts a larger file');

  // Direction holds against reality, not just against itself.
  const { bytes: actualLow } = await recompressImages(source, { ...settings, quality: 0.3 });
  ok(actualLow.length < actual.length, 'estimate: the real run agrees that lower quality is smaller');

  eq(
    describeEstimate({ before: 1000, after: 400, touched: 2, skipped: {}, sampled: false }, (n) => `${n} B`),
    '400 B · about 60% smaller',
    'estimate: reads as a size and a percentage',
  );
  ok(
    describeEstimate({ before: 1000, after: 400, touched: 2, skipped: {}, sampled: true }, (n) => `${n} B`).startsWith('≈'),
    'estimate: a sampled estimate is marked approximate',
  );
  eq(
    describeEstimate({ before: 1000, after: 1000, touched: 0, skipped: {}, sampled: false }, (n) => `${n} B`),
    'Nothing here can be recompressed at this setting.',
    'estimate: says so when there is nothing to gain',
  );
}


/* ------------- 17. word to pdf: the Cause B fixes end to end */

{
  const pkg = (bodyXml) => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
 <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://nikhilkhilwani.github.io" TargetMode="External"/>
</Relationships>`;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:abstractNum w:abstractNumId="0">
  <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
  <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>
 </w:abstractNum>
 <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    return zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rootRels),
      'word/document.xml': strToU8(documentXml),
      'word/_rels/document.xml.rels': strToU8(docRels),
      'word/numbering.xml': strToU8(numbering),
    });
  };

  const body = [
    // The CV pattern: role, tab, right-hand date.
    '<w:p><w:r><w:t>Data Engineer</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2021-2024</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>B</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>H</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t>O</w:t></w:r></w:p>',
    '<w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>Struck</w:t></w:r></w:p>',
    '<w:p><w:hyperlink r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Outer</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Inner</w:t></w:r></w:p>',
    '<w:tbl>',
    '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="3"/></w:tcPr><w:p><w:r><w:t>SpanAll</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>two</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>three</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl>',
  ].join('');

  const result = await docxToPdf(pkg(body));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const items = content.items.filter((i) => i.str.trim());
  const text = items.map((i) => i.str).join(' ');
  const xOf = (needle) => {
    const hit = items.find((i) => i.str.includes(needle));
    return hit ? hit.transform[4] : NaN;
  };

  // TABS — the fix that matters most for a CV.
  ok(text.includes('Data Engineer') && text.includes('2021-2024'), 'cause B: both sides of a tab are present');
  const roleX = xOf('Data Engineer');
  const dateX = xOf('2021-2024');
  ok(
    dateX - roleX > 40,
    `cause B: a tab pushes the date to a stop rather than one space (gap ${(dateX - roleX).toFixed(0)}pt)`,
  );

  // SOFT BREAK — must actually break the line, so the two parts differ in y.
  const yOf = (needle) => {
    const hit = items.find((i) => i.str.includes(needle));
    return hit ? hit.transform[5] : NaN;
  };
  ok(yOf('A') !== yOf('B'), 'cause B: a soft break puts the halves on different lines');

  // SUPERSCRIPT — smaller and raised.
  const sup = items.find((i) => i.str.trim() === '2');
  ok(sup, 'cause B: the superscript character is drawn');
  if (sup) {
    const base = items.find((i) => i.str.includes('H'));
    ok(sup.height < base.height, `cause B: superscript is smaller (${sup.height.toFixed(1)} < ${base.height.toFixed(1)})`);
    ok(sup.transform[5] > base.transform[5], 'cause B: superscript sits higher than the baseline');
  }

  ok(text.includes('Struck'), 'cause B: struck-through text is still drawn');

  // HYPERLINK — a real annotation, not just coloured text.
  const annots = await page.getAnnotations();
  const link = annots.find((a) => a.subtype === 'Link');
  ok(!!link, 'cause B: a Link annotation exists in the PDF');
  eq(link?.url, 'https://nikhilkhilwani.github.io/', 'cause B: it points at the right URL');
  eq(result.links, 1, 'cause B: the conversion reports one clickable link');
  ok(Array.isArray(link?.rect) && link.rect[2] > link.rect[0], 'cause B: the hotspot has a real width');

  // NESTED LIST MARKERS — 1. then a., as Word does.
  ok(text.includes('1.'), 'cause B: the outer ordered item is numbered 1.');
  ok(/\ba\./.test(text), 'cause B: the nested ordered item is lettered a.');

  // MERGED CELL — spans the table rather than sitting in one column.
  ok(text.includes('SpanAll') && text.includes('three'), 'cause B: merged and plain cells both render');

  ok(result.unsupported.length === 0, 'cause B: nothing became an unsupported character');
}


/* ------------- 18. word to pdf: Cause A — appearance from document.xml */

{
  const pkgA = (bodyXml) => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    return zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rootRels),
      'word/document.xml': strToU8(documentXml),
    });
  };

  const body = [
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>CENTRED</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>RIGHTED</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>PLAINLEFT</w:t></w:r></w:p>',
    '<w:p><w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:t>BIGTEXT</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:ind w:left="1440"/></w:pPr><w:r><w:t>INDENTED</w:t></w:r></w:p>',
    // The CV line: a right tab stop near the right margin.
    '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>'
      + '<w:r><w:t>ROLE</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>DATES</w:t></w:r></w:p>',
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join('');

  const result = await docxToPdf(pkgA(body));

  ok(result.styled >= 6, `cause A: appearance recovered for ${result.styled} paragraphs`);
  eq(result.unstyled, 0, 'cause A: every paragraph correlated');

  // Page setup came from the document: US Letter, one-inch margins.
  ok(!!result.pageSetup, 'cause A: page setup was read from the document');
  ok(
    result.pageSetup && Math.abs(result.pageSetup.width - 612) < 1 && Math.abs(result.pageSetup.height - 792) < 1,
    `cause A: Letter size read from w:pgSz (${result.pageSetup?.width.toFixed(0)}x${result.pageSetup?.height.toFixed(0)})`,
  );
  eq(result.pageSetup?.margin, 72, 'cause A: one-inch margin read from w:pgMar');

  const pdf = await pdfjs.getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false }).promise;
  const page1 = await pdf.getPage(1);
  const size = page1.getViewport({ scale: 1 });
  ok(
    Math.abs(size.width - 612) < 1 && Math.abs(size.height - 792) < 1,
    `cause A: the PDF page IS the document's size, not the default A4 (${size.width.toFixed(0)}x${size.height.toFixed(0)})`,
  );

  const items = (await page1.getTextContent()).items.filter((i) => i.str.trim());
  const find = (needle) => items.find((i) => i.str.replace(/\s/g, '').includes(needle));
  const xOf = (needle) => (find(needle) ? find(needle).transform[4] : NaN);
  const endOf = (needle) => {
    const hit = find(needle);
    return hit ? hit.transform[4] + hit.width : NaN;
  };

  const left = xOf('PLAINLEFT');
  ok(Number.isFinite(left), 'cause A: the plain paragraph is drawn');

  // ALIGNMENT — the most visible of the lot.
  ok(xOf('CENTRED') > left + 40, `cause A: a centred paragraph starts well right of the margin (${xOf('CENTRED').toFixed(0)} vs ${left.toFixed(0)})`);
  ok(xOf('RIGHTED') > xOf('CENTRED'), 'cause A: a right-aligned paragraph starts further right still');
  ok(
    Math.abs(endOf('RIGHTED') - (612 - 72)) < 6,
    `cause A: right-aligned text ends at the right margin (${endOf('RIGHTED').toFixed(0)} vs ${612 - 72})`,
  );

  // SIZE
  const big = find('BIGTEXT');
  const plain = find('PLAINLEFT');
  ok(big.height > plain.height * 1.6, `cause A: w:sz 48 renders larger (${big.height.toFixed(1)} vs ${plain.height.toFixed(1)})`);

  // INDENT
  ok(
    Math.abs(xOf('INDENTED') - (left + 72)) < 2,
    `cause A: a 1440-twip indent moves the text one inch (${(xOf('INDENTED') - left).toFixed(0)}pt)`,
  );

  // RIGHT TAB STOP — the CV case
  ok(
    Math.abs(endOf('DATES') - (72 + 450)) < 8,
    `cause A: the date ends on the declared right stop (${endOf('DATES').toFixed(0)} vs ${72 + 450})`,
  );
  ok(xOf('DATES') - endOf('ROLE') > 100, 'cause A: and there is a real gap, not a single space');

  // Turning it off must fall back to the requested geometry.
  const forced = await docxToPdf(pkgA(body), { useDocumentPageSetup: false });
  const forcedPdf = await pdfjs.getDocument({ data: new Uint8Array(forced.bytes), isEvalSupported: false }).promise;
  const forcedSize = (await forcedPdf.getPage(1)).getViewport({ scale: 1 });
  ok(
    Math.abs(forcedSize.width - 595.28) < 1,
    `cause A: opting out uses the chosen page size instead (${forcedSize.width.toFixed(0)})`,
  );

  // A document with no sectPr must not break anything.
  const bare = await docxToPdf(pkgA('<w:p><w:r><w:t>Just text</w:t></w:r></w:p>'));
  eq(bare.pageSetup, null, 'cause A: no sectPr reports no page setup');
  ok(bare.pages === 1, 'cause A: and still converts fine');

  // Correlation must degrade safely, never misformat.
  ok(describeConversion(result).includes('recovered for'), 'cause A: the summary reports what was recovered');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
