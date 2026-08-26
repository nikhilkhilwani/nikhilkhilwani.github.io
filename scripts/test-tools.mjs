/**
 * Unit tests for the pure logic behind the image, QR, and PDF tools.
 * Run with `npm test`. Node 24 strips the TS types on import directly.
 *
 * Anything needing a DOM (canvas encode, pdf.js render) is not covered here —
 * scripts/test-dom.mjs checks the wiring against the built HTML instead.
 */

import {
  formatBytes, savingsPercent, sanitizeFilename, stemOf, withExtension,
  uniqueName, pageLabel, parsePageRange, isEncodeType, ENCODE_TYPES,
} from '../src/lib/ui/files.ts';
import {
  buildMatrix, isDark, matrixToSvg, wifiPayload, vcardPayload, emailPayload,
  normalizeUrlish, escapeMicroformat,
} from '../src/lib/qr/qr.ts';
import { fitWithin } from '../src/lib/img/raster.ts';
import { passwordStrength, describePermissions, OPEN_PERMISSIONS } from '../src/lib/pdf/protect.ts';
import {
  LIMITS, screenFiles, formatLimit, describeRejections,
  canvasPixelsFor, exceedsCanvasBudget, largestSafeScale,
} from '../src/lib/ui/limits.ts';
import { classifyImage, percentSaved, describeReport, isNoOp } from '../src/lib/pdf/compress.ts';
import { parseBlocks, tidyRuns, decodeEntities, unsupportedCharacters, blockText } from '../src/lib/docx/blocks.ts';
import { wrapRuns, layout, columnWidths, A4, DEFAULT_SCALE } from '../src/lib/docx/layout.ts';

let fail = 0;
let pass = 0;

const eq = (a, b, msg) => {
  if (a !== b) {
    console.log(`FAIL ${msg}\n       got:  ${JSON.stringify(a)}\n       want: ${JSON.stringify(b)}`);
    fail++;
  } else {
    pass++;
  }
};
const deep = (a, b, msg) => eq(JSON.stringify(a), JSON.stringify(b), msg);
const ok = (cond, msg) => eq(!!cond, true, msg);
const throws = (fn, msg) => {
  try {
    fn();
    console.log(`FAIL ${msg}: expected a throw`);
    fail++;
  } catch {
    pass++;
  }
};

/* ------------------------------------------------------------------ files */

eq(formatBytes(0), '0 B', 'formatBytes 0');
eq(formatBytes(1023), '1023 B', 'formatBytes just under 1 kB');
eq(formatBytes(1024), '1.0 kB', 'formatBytes 1 kB');
eq(formatBytes(1536), '1.5 kB', 'formatBytes 1.5 kB');
eq(formatBytes(10 * 1024), '10 kB', 'formatBytes drops the decimal at 10');
eq(formatBytes(5.5 * 1024 * 1024), '5.5 MB', 'formatBytes MB');
eq(formatBytes(3 * 1024 ** 3), '3.0 GB', 'formatBytes GB');
eq(formatBytes(-1), '—', 'formatBytes rejects negatives');
eq(formatBytes(NaN), '—', 'formatBytes rejects NaN');

eq(savingsPercent(1000, 250), 75, 'savings 75%');
eq(savingsPercent(1000, 1200), -20, 'savings negative when it grows');
eq(savingsPercent(0, 100), 0, 'savings guards divide-by-zero');

eq(sanitizeFilename('C:\\Users\\me\\shot.png'), 'shot.png', 'strips a Windows path');
eq(sanitizeFilename('/tmp/a/b/shot.png'), 'shot.png', 'strips a POSIX path');
eq(sanitizeFilename('re:port<1>.pdf'), 'report1.pdf', 'drops reserved characters');
eq(sanitizeFilename('my photo-2.png'), 'my photo-2.png', 'keeps spaces and hyphens');
eq(sanitizeFilename('...hidden.png'), 'hidden.png', 'strips leading dots');
eq(sanitizeFilename(''), 'file', 'falls back when empty');
eq(sanitizeFilename('???'), 'file', 'falls back when fully stripped');
eq(sanitizeFilename(`a${String.fromCharCode(9)}b.png`), 'ab.png', 'drops control characters');

eq(stemOf('shot.final.png'), 'shot.final', 'stem keeps inner dots');
eq(stemOf('noext'), 'noext', 'stem of an extensionless name');
eq(withExtension('photo.png', 'jpg'), 'photo.jpg', 'swaps the extension');
eq(withExtension('photo.png', '.jpg'), 'photo.jpg', 'tolerates a leading dot');
eq(withExtension('archive.tar.gz', 'zip'), 'archive.tar.zip', 'swaps only the last extension');

const taken = new Set(['a.png']);
eq(uniqueName('a.png', taken), 'a (2).png', 'first collision');
taken.add('a (2).png');
eq(uniqueName('a.png', taken), 'a (3).png', 'second collision');
eq(uniqueName('b.png', taken), 'b.png', 'no collision passes through');

eq(pageLabel(3, 9), '3', 'page label needs no padding under 10');
eq(pageLabel(3, 10), '03', 'page label pads to two digits');
eq(pageLabel(7, 120), '007', 'page label pads to three digits');

deep(parsePageRange('', 3), [1, 2, 3], 'blank range means every page');
deep(parsePageRange('   ', 3), [1, 2, 3], 'whitespace range means every page');
deep(parsePageRange('2', 5), [2], 'single page');
deep(parsePageRange('2-4', 5), [2, 3, 4], 'simple range');
deep(parsePageRange('4-2', 5), [2, 3, 4], 'reversed range is normalised');
deep(parsePageRange('1,3,5', 5), [1, 3, 5], 'comma list');
deep(parsePageRange('1-2, 2-3', 5), [1, 2, 3], 'overlapping ranges de-duplicate');
deep(parsePageRange('3-', 5), [3, 4, 5], 'open-ended range runs to the end');
deep(parsePageRange('-3', 5), [1, 2, 3], 'open-started range starts at 1');
deep(parsePageRange('4-99', 5), [4, 5], 'range is clamped to the page count');
deep(parsePageRange('0', 5), [], 'page 0 is rejected');
deep(parsePageRange('9', 5), [], 'out-of-range page is rejected');
deep(parsePageRange('abc', 5), [], 'garbage yields nothing');
deep(parsePageRange('2,abc,4', 5), [2, 4], 'garbage between valid entries is skipped');
deep(parsePageRange('1', 0), [], 'no pages means no selection');
deep(parsePageRange('5,1,3', 5), [1, 3, 5], 'output is always ascending');

ok(isEncodeType('image/png'), 'isEncodeType accepts png');
ok(!isEncodeType('image/gif'), 'isEncodeType rejects gif');
eq(ENCODE_TYPES['image/png'].lossy, false, 'png is lossless');
eq(ENCODE_TYPES['image/jpeg'].lossy, true, 'jpeg is lossy');

/* ----------------------------------------------------------------- raster */

deep(fitWithin({ width: 800, height: 600 }, null), { width: 800, height: 600 }, 'no cap is a no-op');
deep(fitWithin({ width: 800, height: 600 }, 0), { width: 800, height: 600 }, 'zero cap is a no-op');
deep(fitWithin({ width: 800, height: 600 }, 2000), { width: 800, height: 600 }, 'never upscales');
deep(fitWithin({ width: 4000, height: 2000 }, 1000), { width: 1000, height: 500 }, 'caps the long edge');
deep(fitWithin({ width: 2000, height: 4000 }, 1000), { width: 500, height: 1000 }, 'caps a portrait image');
deep(fitWithin({ width: 1000, height: 1000 }, 1000), { width: 1000, height: 1000 }, 'exact fit is a no-op');
deep(fitWithin({ width: 1000, height: 10 }, 100), { width: 100, height: 1 }, 'extreme ratio keeps 1px height');
deep(fitWithin({ width: 10, height: 1000 }, 100), { width: 1, height: 100 }, 'extreme ratio keeps 1px width');

/* --------------------------------------------------------------------- QR */

const m = buildMatrix('HELLO', 'M');
eq(m.size, 21, 'short payload is a version-1 21x21 matrix');
eq(m.version, 1, 'version 1');
eq(m.data.length, 21 * 21, 'matrix data length matches size squared');

// The finder pattern is fixed by the spec: a 7x7 ring in each corner.
ok(isDark(m, 0, 0), 'finder: top-left corner is dark');
ok(isDark(m, 0, 6), 'finder: top-left ring right edge');
ok(!isDark(m, 0, 7), 'finder: separator right of the ring is light');
ok(isDark(m, 6, 6), 'finder: ring bottom-right');
ok(!isDark(m, 1, 1), 'finder: inner ring gap is light');
ok(isDark(m, 2, 2), 'finder: 3x3 core is dark');
ok(isDark(m, 0, 20), 'finder: top-right corner is dark');
ok(isDark(m, 20, 0), 'finder: bottom-left corner is dark');
ok(!isDark(m, 20, 20), 'no finder in the bottom-right corner');

// Timing pattern: row 6 alternates dark/light between the finders.
ok(isDark(m, 6, 8), 'timing pattern starts dark');
ok(!isDark(m, 6, 9), 'timing pattern alternates');
ok(isDark(m, 6, 10), 'timing pattern alternates back');

eq(buildMatrix('x'.repeat(200), 'L').version > buildMatrix('x', 'L').version, true, 'more data needs a higher version');
eq(buildMatrix('SAME', 'H').size >= buildMatrix('SAME', 'L').size, true, 'stronger EC needs at least as much room');
throws(() => buildMatrix('', 'M'), 'empty payload throws');
throws(() => buildMatrix('x'.repeat(8000), 'H'), 'oversized payload throws');

const svg = matrixToSvg(m, { scale: 4, margin: 2, dark: '#111111', light: '#eeeeee' });
const side = (21 + 4) * 4;
ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'svg has the xmlns');
ok(svg.includes(`width="${side}" height="${side}"`), 'svg size accounts for the quiet zone');
ok(svg.includes(`viewBox="0 0 ${side} ${side}"`), 'svg viewBox matches');
ok(svg.includes('fill="#eeeeee"'), 'svg paints the background');
ok(svg.includes('fill="#111111"'), 'svg paints the modules');
ok(svg.trimEnd().endsWith('</svg>'), 'svg is closed');
// One rect per dark module, plus one for the background.
const rects = (svg.match(/<rect/g) ?? []).length;
const darkCount = m.data.reduce((n, bit) => n + (bit === 1 ? 1 : 0), 0);
eq(rects, darkCount + 1, 'one rect per dark module plus the background');
ok(!matrixToSvg(m, { radius: 0 }).includes(' rx='), 'no rx attribute when rounding is off');
ok(matrixToSvg(m, { radius: 0.5 }).includes(' rx='), 'rx attribute appears when rounding is on');
// A color is attacker-controllable only via the URL/DOM, but escape it anyway.
ok(
  !matrixToSvg(m, { dark: '"><script>x</script>' }).includes('<script>'),
  'colors are attribute-escaped',
);

eq(escapeMicroformat('pa;ss'), 'pa\\;ss', 'escapes a semicolon');
eq(escapeMicroformat('a,b:c"d\\e'), 'a\\,b\\:c\\"d\\\\e', 'escapes every structural character');

eq(
  wifiPayload({ ssid: 'Home', password: 'pw', auth: 'WPA' }),
  'WIFI:S:Home;T:WPA;P:pw;;',
  'wifi payload shape',
);
eq(
  wifiPayload({ ssid: 'My;Net', password: 'a;b', auth: 'WPA' }),
  'WIFI:S:My\\;Net;T:WPA;P:a\\;b;;',
  'wifi escapes semicolons in both fields',
);
eq(
  wifiPayload({ ssid: 'Cafe', password: 'ignored', auth: 'nopass' }),
  'WIFI:S:Cafe;T:nopass;;',
  'open network carries no password field',
);
eq(
  wifiPayload({ ssid: 'Hid', password: 'p', auth: 'WPA', hidden: true }),
  'WIFI:S:Hid;T:WPA;P:p;H:true;;',
  'hidden flag is appended',
);
eq(wifiPayload({ ssid: '  ', password: 'p', auth: 'WPA' }), '', 'blank ssid yields no payload');

const card = vcardPayload({ name: 'Nikhil Khilwani', org: 'Acme, Inc.', phone: '+1 555' });
ok(card.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'), 'vcard header with CRLF');
ok(card.endsWith('END:VCARD'), 'vcard footer');
ok(card.includes('N:Khilwani;Nikhil;;;'), 'vcard splits the name');
ok(card.includes('FN:Nikhil Khilwani'), 'vcard formatted name');
ok(card.includes('ORG:Acme\\, Inc.'), 'vcard escapes a comma');
ok(!card.includes('EMAIL'), 'vcard omits fields that were left blank');
eq(vcardPayload({ name: '' }), '', 'blank name yields no vcard');
ok(vcardPayload({ name: 'Cher' }).includes('N:;Cher;;;'), 'single-word name has no family part');

eq(emailPayload({ to: 'a@b.co' }), 'mailto:a@b.co', 'bare mailto');
eq(
  emailPayload({ to: 'a@b.co', subject: 'Hi there' }),
  'mailto:a@b.co?subject=Hi%20there',
  'mailto uses %20 rather than +',
);
ok(emailPayload({ to: 'a@b.co', body: 'x&y' }).includes('body=x%26y'), 'mailto escapes an ampersand');
eq(emailPayload({ to: '' }), '', 'blank address yields no payload');

eq(normalizeUrlish('example.com'), 'https://example.com', 'bare domain gets a scheme');
eq(normalizeUrlish('example.com/a?b=1'), 'https://example.com/a?b=1', 'bare domain with a path');
eq(normalizeUrlish('https://x.dev'), 'https://x.dev', 'existing scheme is left alone');
eq(normalizeUrlish('mailto:a@b.co'), 'mailto:a@b.co', 'non-http scheme is left alone');
eq(normalizeUrlish('just some text'), 'just some text', 'plain text is not turned into a URL');
eq(normalizeUrlish('  '), '', 'blank input stays blank');

/* ------------------------------------------------------------- protect-pdf */

// Length is the dominant factor on purpose: a long lowercase passphrase should
// out-score a short mangled word.
eq(passwordStrength('').score, 0, 'empty password scores 0');
eq(passwordStrength('').label, 'Empty', 'empty password is labelled');
eq(passwordStrength('abc').score, 0, 'under 6 chars scores 0');
eq(passwordStrength('abc').label, 'Too short', 'short password says so');
eq(passwordStrength('abcdefg').score, 1, '7 lowercase chars score 1');
eq(passwordStrength('abcdefghij').score, 1, '10 lowercase only is penalised to 1');
eq(passwordStrength('Abcdef1!').score, 2, '8 chars with 4 classes scores 2');
eq(passwordStrength('Abcdefgh12!').score, 3, '11 chars with 4 classes scores 3');
eq(passwordStrength('correcthorsebatterystaple').score, 4, 'a long passphrase reaches 4');
ok(
  passwordStrength('correcthorsebatterystaple').score > passwordStrength('Xy7!q').score,
  'long passphrase beats a short mangled word',
);
for (const pw of ['', 'a', 'abcdef', 'Abcdef1!', 'x'.repeat(40)]) {
  const s = passwordStrength(pw);
  ok(s.score >= 0 && s.score <= 4, `score stays in range for ${JSON.stringify(pw.slice(0, 8))}`);
  ok(!!s.label && !!s.hint, 'every score has a label and a hint');
}

eq(
  describePermissions(OPEN_PERMISSIONS),
  'No restrictions — the password is only needed to open the file.',
  'all-allowed permissions read as unrestricted',
);
ok(
  describePermissions({ ...OPEN_PERMISSIONS, printing: false }).includes('block printing'),
  'blocked printing is described',
);
ok(
  describePermissions({ ...OPEN_PERMISSIONS, printing: 'lowResolution' }).includes('high-quality printing'),
  'low-resolution printing is described',
);
ok(
  describePermissions({ ...OPEN_PERMISSIONS, copying: false, modifying: false }).includes(' and '),
  'two restrictions are joined with "and"',
);
eq(
  describePermissions({ printing: false, copying: false, modifying: false, annotating: false, fillingForms: false }),
  'Readers that honour permissions will block printing, copying text, editing, commenting and filling forms.',
  'all restrictions listed in order',
);

/* ---------------------------------------------------------------- limits */

const MB = 1024 * 1024;
const f = (name, mb) => ({ name, size: Math.round(mb * MB) });

eq(formatLimit(40 * MB), '40 MB', 'formatLimit reads as whole megabytes');
eq(formatLimit(80 * MB), '80 MB', 'formatLimit 80 MB');

// Per-file ceiling.
{
  const r = screenFiles([f('small.jpg', 1), f('huge.jpg', 50)], { perFile: LIMITS.image });
  eq(r.accepted.length, 1, 'one file accepted under the per-file limit');
  eq(r.accepted[0].name, 'small.jpg', 'the small one is kept');
  eq(r.rejected.length, 1, 'the oversized file is refused');
  eq(r.rejected[0].name, 'huge.jpg', 'refusal names the file');
  ok(/over the 40 MB limit/.test(r.rejected[0].reason), `reason explains: ${r.rejected[0].reason}`);
}

// Exactly at the limit is allowed; one byte over is not.
{
  const r = screenFiles(
    [{ name: 'exact', size: LIMITS.image }, { name: 'over', size: LIMITS.image + 1 }],
    { perFile: LIMITS.image },
  );
  eq(r.accepted.length, 1, 'a file exactly at the limit is accepted');
  eq(r.accepted[0].name, 'exact', 'boundary is inclusive');
  eq(r.rejected[0].name, 'over', 'one byte over is refused');
}

// Batch total, including what the tool already holds.
{
  const r = screenFiles([f('a', 30), f('b', 30), f('c', 30)], {
    perFile: LIMITS.image,
    total: 100 * MB,
  });
  eq(r.accepted.length, 3, 'three 30 MB files fit inside 100 MB');
  eq(r.rejected.length, 0, 'nothing refused');
}
{
  const r = screenFiles([f('a', 30), f('b', 30), f('c', 30), f('d', 30)], {
    perFile: LIMITS.image,
    total: 100 * MB,
  });
  eq(r.accepted.length, 3, 'the fourth 30 MB file breaks the 100 MB batch');
  eq(r.rejected.length, 1, 'and is refused');
  ok(/would put this batch over 100 MB/.test(r.rejected[0].reason), 'batch reason explains itself');
}
{
  const r = screenFiles([f('new', 30)], {
    perFile: LIMITS.image,
    total: 100 * MB,
    alreadyHeld: 80 * MB,
  });
  eq(r.accepted.length, 0, 'files already held count towards the batch total');
  eq(r.rejected.length, 1, 'so the next drop is refused');
}
{
  const r = screenFiles([f('a', 1)], { perFile: LIMITS.image });
  eq(r.rejected.length, 0, 'no total means only the per-file limit applies');
}
deep(screenFiles([], { perFile: LIMITS.image }), { accepted: [], rejected: [] }, 'empty input is empty output');

eq(describeRejections([]), '', 'nothing refused produces no message');
eq(
  describeRejections([{ name: 'big.pdf', size: 1, reason: 'over the 80 MB limit for one file' }]),
  'big.pdf was skipped — over the 80 MB limit for one file.',
  'a single refusal names the file',
);
ok(
  describeRejections([
    { name: 'a', size: 1, reason: 'over the 40 MB limit for one file' },
    { name: 'b', size: 1, reason: 'over the 40 MB limit for one file' },
  ]).startsWith('2 files were skipped — over the 40 MB limit'),
  'several refusals sharing a reason are summarised with it',
);
ok(
  describeRejections([
    { name: 'a', size: 1, reason: 'over the 40 MB limit for one file' },
    { name: 'b', size: 1, reason: 'would put this batch over 200 MB' },
  ]) === '2 files were skipped.',
  'mixed reasons are summarised without a misleading single cause',
);

// Canvas budget. A4 at 72 dpi is 595x842 pt.
eq(canvasPixelsFor(595, 842, 1), 595 * 842, 'canvas pixels at scale 1');
eq(canvasPixelsFor(595, 842, 2), 1190 * 1684, 'canvas pixels at scale 2');
ok(!exceedsCanvasBudget(canvasPixelsFor(595, 842, 4)), 'A4 at 288 dpi is within budget');
// A0 is 2384x3370 pt — the case that used to kill the tab.
ok(exceedsCanvasBudget(canvasPixelsFor(2384, 3370, 4)), 'A0 at 288 dpi exceeds the budget');
ok(!exceedsCanvasBudget(canvasPixelsFor(2384, 3370, 2)), 'A0 at 144 dpi is fine');

ok(largestSafeScale(2384, 3370) >= 2, 'a safe scale for A0 is at least 2');
ok(
  !exceedsCanvasBudget(canvasPixelsFor(2384, 3370, largestSafeScale(2384, 3370))),
  'the suggested scale actually fits the budget',
);
ok(
  exceedsCanvasBudget(canvasPixelsFor(2384, 3370, largestSafeScale(2384, 3370) + 0.2)),
  'and is close to the largest that does',
);
eq(largestSafeScale(0, 0), 1, 'a degenerate page size does not divide by zero');
ok(largestSafeScale(100000, 100000) >= 0.1, 'an absurd page still yields a positive scale');

/* ------------------------------------------------------------- compress-pdf */

const img = (over = {}) => ({
  filters: ['/DCTDecode'],
  colorSpace: '/DeviceRGB',
  hasSMask: false,
  bytes: 200_000,
  ...over,
});

eq(classifyImage(img()), 'recompress', 'an RGB JPEG is recompressible');
eq(classifyImage(img({ colorSpace: '/DeviceGray' })), 'recompress', 'a grayscale JPEG is recompressible');
eq(classifyImage(img({ hasSMask: true })), 'transparency', 'alpha is refused — JPEG has none');
eq(classifyImage(img({ filters: ['/FlateDecode'] })), 'not a JPEG', 'lossless images are left alone');
eq(classifyImage(img({ filters: ['/JPXDecode'] })), 'not a JPEG', 'JPEG 2000 is left alone');
eq(classifyImage(img({ filters: ['/CCITTFaxDecode'] })), 'not a JPEG', 'fax encoding is left alone');
eq(classifyImage(img({ colorSpace: '/DeviceCMYK' })), 'unsupported colour', 'CMYK is refused rather than colour-shifted');
eq(classifyImage(img({ colorSpace: '/Indexed' })), 'unsupported colour', 'indexed colour is refused');
eq(classifyImage(img({ colorSpace: undefined })), 'unsupported colour', 'a missing colour space is refused');
eq(classifyImage(img({ bytes: 500 })), 'already small', 'a tiny image is not worth touching');
// Transparency outranks everything: it is the one that would visibly corrupt.
eq(classifyImage(img({ hasSMask: true, filters: ['/FlateDecode'] })), 'transparency', 'alpha is checked first');
eq(classifyImage(img({ bytes: 5000 }), 4096), 'recompress', 'the small-image floor is configurable');

eq(percentSaved(1000, 250), 75, 'percentSaved 75%');
eq(percentSaved(1000, 1000), 0, 'percentSaved 0% when unchanged');
eq(percentSaved(1000, 1200), -20, 'percentSaved negative when it grew');
eq(percentSaved(0, 10), 0, 'percentSaved guards divide-by-zero');

const rep = (over = {}) => ({
  before: 1000, after: 400, touched: 3, skipped: {}, textPreserved: true, ...over,
});

ok(describeReport(rep()).includes('Recompressed 3 images'), 'report counts what it touched');
ok(describeReport(rep()).includes('60% smaller'), 'report states the saving');
ok(describeReport(rep()).includes('Text and vectors are untouched'), 'report states what survived');
ok(describeReport(rep({ touched: 1 })).includes('1 image —'), 'report is singular for one image');
ok(
  describeReport(rep({ skipped: { transparency: 2, 'not a JPEG': 1 } })).includes('Left alone: 2 transparency, 1 not a JPEG'),
  'report names what it skipped and why',
);
ok(
  describeReport(rep({ textPreserved: false, touched: 5 })).includes('Text is no longer selectable'),
  'flatten mode says plainly what it cost',
);
ok(describeReport(rep({ after: 1000 })).includes('the same size'), 'no change is described honestly');
ok(describeReport(rep({ after: 1200 })).includes('20% larger'), 'growth is described honestly');

ok(isNoOp(rep({ touched: 0 })), 'recompressing nothing is a no-op');
ok(!isNoOp(rep({ touched: 1 })), 'touching one image is not a no-op');
ok(!isNoOp(rep({ textPreserved: false, touched: 0 })), 'flattening is never reported as a no-op');


/* --------------------------------------------------------- docx: blocks */

eq(decodeEntities('a &amp; b'), 'a & b', 'decodes &amp;');
eq(decodeEntities('&lt;tag&gt;'), '<tag>', 'decodes angle brackets');
eq(decodeEntities('&#8212;'), '—', 'decodes a numeric entity');
eq(decodeEntities('&#x2014;'), '—', 'decodes a hex entity');
eq(decodeEntities('&mdash;&nbsp;x'), '— x', 'decodes named entities');
eq(decodeEntities('&notreal;'), '&notreal;', 'leaves an unknown entity alone');

deep(tidyRuns([{ text: 'a' }, { text: 'b' }]), [{ text: 'ab' }], 'merges adjacent plain runs');
deep(
  tidyRuns([{ text: 'a' }, { text: 'b', bold: true }]),
  [{ text: 'a' }, { text: 'b', bold: true }],
  'keeps differently styled runs apart',
);
deep(tidyRuns([{ text: '' }, { text: 'x' }]), [{ text: 'x' }], 'drops empty runs');
deep(tidyRuns([{ text: '  a   b  ' }]), [{ text: 'a b' }], 'collapses and trims whitespace');

{
  const blocks = parseBlocks('<h1>Title</h1><p>Body <strong>bold</strong> and <em>italic</em>.</p>');
  eq(blocks.length, 2, 'heading and paragraph parsed');
  eq(blocks[0].kind, 'heading', 'first block is a heading');
  eq(blocks[0].level, 1, 'h1 becomes level 1');
  eq(blockText(blocks[0]), 'Title', 'heading text');
  eq(blocks[1].kind, 'paragraph', 'second block is a paragraph');
  const styled = blocks[1].runs;
  ok(styled.some((r) => r.bold && r.text === 'bold'), 'bold run preserved');
  ok(styled.some((r) => r.italic && r.text === 'italic'), 'italic run preserved');
}

eq(parseBlocks('<h2>A</h2>')[0].level, 2, 'h2 becomes level 2');
eq(parseBlocks('<h6>A</h6>')[0].level, 3, 'h6 clamps to level 3');

{
  const blocks = parseBlocks('<ul><li>one</li><li>two</li></ul>');
  eq(blocks.length, 2, 'two list items');
  eq(blocks[0].kind, 'listItem', 'parsed as a list item');
  eq(blocks[0].ordered, false, 'ul is unordered');
  eq(blocks[0].marker, '•', 'bullet marker');
}
{
  const blocks = parseBlocks('<ol><li>one</li><li>two</li><li>three</li></ol>');
  deep(blocks.map((b) => b.marker), ['1.', '2.', '3.'], 'ol numbers its items in order');
  ok(blocks.every((b) => b.ordered), 'ol items are ordered');
}
{
  const blocks = parseBlocks('<ul><li>a<ul><li>b</li></ul></li></ul>');
  ok(blocks.some((b) => b.level === 2), 'a nested list reports a deeper level');
}

{
  const blocks = parseBlocks('<table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>');
  eq(blocks.length, 1, 'a table is one block');
  eq(blocks[0].kind, 'table', 'parsed as a table');
  eq(blocks[0].rows.length, 1, 'one row');
  eq(blocks[0].rows[0].length, 2, 'two cells');
  eq(blocks[0].rows[0][0][0].text, 'A', 'cell content preserved');
}
eq(
  parseBlocks('<table><tr><th><p>H</p></th></tr></table>')[0].rows[0][0][0].text,
  'H',
  'th is treated as a cell',
);

eq(parseBlocks('<p>x</p><hr /><p>y</p>').filter((b) => b.kind === 'rule').length, 1, 'hr becomes a rule');
eq(
  parseBlocks('<p><img src="data:image/png;base64,AAA" /></p>').filter((b) => b.kind === 'image').length,
  1,
  'a data-URI image becomes an image block',
);
eq(
  parseBlocks('<p><img src="https://example.com/a.png" /></p>').filter((b) => b.kind === 'image').length,
  0,
  'a remote image is not embedded — it cannot be fetched',
);
eq(
  blockText(parseBlocks('<div><span>text in unknown tags</span></div>')[0]),
  'text in unknown tags',
  'unknown tags are transparent, so no content is lost',
);
deep(parseBlocks(''), [], 'empty HTML yields no blocks');
deep(parseBlocks('<p></p>'), [], 'an empty paragraph yields no block');

deep(unsupportedCharacters(parseBlocks('<p>José Müller</p>')), [], 'Latin-1 accents are supported');
ok(unsupportedCharacters(parseBlocks('<p>नमस्ते hello</p>')).length > 0, 'Devanagari is reported as unsupported');
deep(unsupportedCharacters(parseBlocks('<p>an em—dash and a bullet •</p>')), [], 'punctuation WinAnsi covers is not flagged');

/* --------------------------------------------------------- docx: layout */

// A predictable measurer: every character is exactly half the font size wide.
const half = (text, style) => text.length * style.size * 0.5;

{
  const lines = wrapRuns([{ text: 'aaaa bbbb cccc' }], 10, 25, half);
  eq(lines.length, 3, 'wraps at the available width');
  eq(lines[0].pieces.map((p) => p.text).join(''), 'aaaa', 'first line holds one word');
}
eq(wrapRuns([{ text: 'short' }], 10, 500, half).length, 1, 'text that fits stays on one line');
eq(
  wrapRuns([{ text: 'enormouslylongsingleword' }], 10, 20, half).length,
  1,
  'a word longer than the line is placed rather than looping forever',
);
{
  // Wrapping must work ACROSS runs, so styling never forces a break.
  const lines = wrapRuns([{ text: 'aa ' }, { text: 'bb', bold: true }, { text: ' cc' }], 10, 500, half);
  eq(lines.length, 1, 'styled runs share a line');
  ok(lines[0].pieces.some((p) => p.bold), 'the bold piece is on that line');
}
{
  const lines = wrapRuns([{ text: 'aaaa bbbb' }], 10, 25, half);
  eq(lines.length, 2, 'two words wrap at a 25pt width');
  ok(!/^\s/.test(lines[1].pieces[0].text), 'a wrapped line never starts with whitespace');
}
deep(wrapRuns([], 10, 100, half), [], 'no runs means no lines');

deep(columnWidths(2, 108, 8), [50, 50], 'two columns split the width minus the gap');
eq(columnWidths(3, 200, 10).length, 3, 'three columns');
ok(columnWidths(20, 100, 8).every((w) => w >= 24), 'columns never collapse below a floor');
deep(columnWidths(0, 100), [], 'zero columns yields nothing');

{
  // Pagination: enough paragraphs that one page cannot hold them.
  const many = Array.from({ length: 60 }, () => ({
    kind: 'paragraph',
    runs: [{ text: 'This is a paragraph with enough words in it to occupy a couple of lines each time.' }],
  }));
  const pages = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure: half });
  ok(pages.length > 1, `long input paginates (${pages.length} pages)`);

  // Nothing may be dropped: every paragraph must appear somewhere.
  const drawn = pages
    .flatMap((p) => p.items)
    .filter((i) => i.kind === 'line')
    .flatMap((i) => i.line.pieces)
    .map((p) => p.text)
    .join(' ');
  eq((drawn.match(/paragraph/g) ?? []).length, 60, 'every paragraph survives pagination');

  // Nothing may be drawn outside the page.
  const off = pages.flatMap((p) => p.items).filter((i) => i.y < 0 || i.y > A4.height);
  eq(off.length, 0, 'nothing is laid out off the page');
}
eq(
  layout([{ kind: 'paragraph', runs: [{ text: 'one line' }] }], { geometry: A4, scale: DEFAULT_SCALE, measure: half }).length,
  1,
  'a short document is a single page',
);
deep(layout([], { geometry: A4, scale: DEFAULT_SCALE, measure: half }), [], 'no blocks means no pages');
{
  const pages = layout([{ kind: 'table', rows: [[[{ text: 'A' }], [{ text: 'B' }]]] }], {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure: half,
  });
  eq(pages[0].items.filter((i) => i.kind === 'cellBox').length, 2, 'a table row draws one box per cell');
}

/* -------------------------------------------------------------------- end */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
