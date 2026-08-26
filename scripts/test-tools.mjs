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
import { parseColor, hexToRgb, rgbToHex } from '../src/lib/color/convert.ts';
import { contrastRatio, relativeLuminance } from '../src/lib/contrast/wcag.ts';
import { passwordStrength, describePermissions, OPEN_PERMISSIONS } from '../src/lib/pdf/protect.ts';
import {
  LIMITS, screenFiles, formatLimit, describeRejections,
  canvasPixelsFor, exceedsCanvasBudget, largestSafeScale,
} from '../src/lib/ui/limits.ts';
import { classifyImage, percentSaved, describeReport, isNoOp } from '../src/lib/pdf/compress.ts';
import {
  parseBlocks, tidyRuns, decodeEntities, unsupportedCharacters, blockText,
  orderedMarker, letters, roman,
} from '../src/lib/docx/blocks.ts';
import {
  wrapRuns, layout, columnWidths, A4, DEFAULT_SCALE, nextTabStop, tableColumns, spanWidth,
  alignLine, lineWidth,
} from '../src/lib/docx/layout.ts';
import {
  twips, readParagraphProps, readPageSetup, correlate, paragraphText, normalizeText, withoutTables,
} from '../src/lib/docx/wordxml.ts';

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
/** Float comparison, for the color math where exact equality is meaningless. */
const near = (a, b, tol, msg) => {
  if (!(Math.abs(a - b) <= tol)) {
    console.log(`FAIL ${msg}\n       got:  ${a}\n       want: ~${b} (±${tol})`);
    fail++;
  } else {
    pass++;
  }
};
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

/* ------------------------------------------------ QR: color and contrast */

// The QR generator parses both color inputs and refuses a pair a scanner
// cannot separate, so parseColor and contrastRatio are part of its contract.
// These assertions moved here from the retired scripts/test-color.mjs when the
// color converter, contrast checker and palette collection were removed.

near(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21, 0.001, 'black/white = 21');
near(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }), 1, 0.001, 'white/white = 1');
// The published WCAG boundary case: #767676 is the darkest grey that clears AA
// on white, which is exactly the threshold the scan warning sits on.
near(contrastRatio(hexToRgb('#767676'), hexToRgb('#ffffff')), 4.54, 0.02, '#767676 on white');
near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1, 0.001, 'white luminance = 1');
near(relativeLuminance({ r: 0, g: 0, b: 0 }), 0, 0.001, 'black luminance = 0');

// <input type="color"> only ever yields #rrggbb, but parseColor is the public
// entry point and still accepts the wider syntax, so keep covering it.
eq(rgbToHex(parseColor('#6EE7D7')), '#6ee7d7', 'parse hex upper');
eq(rgbToHex(parseColor('#fff')), '#ffffff', 'parse short hex');
eq(rgbToHex(parseColor('rgb(110, 231, 215)')), '#6ee7d7', 'parse rgb()');
eq(rgbToHex(parseColor('rgb(110 231 215)')), '#6ee7d7', 'parse space rgb()');
eq(rgbToHex(parseColor('hsl(172.07, 71.6%, 66.9%)')), '#6ee7d7', 'parse precise hsl()');
eq(rgbToHex(parseColor('hsv(172.07, 52.4%, 90.6%)')), '#6ee7d7', 'parse hsv()');
eq(rgbToHex(parseColor('cmyk(52.4%, 0%, 6.9%, 9.4%)')), '#6ee7d7', 'parse cmyk()');
eq(rgbToHex(parseColor('oklch(0.628 0.2577 29.23)')), '#ff0000', 'parse oklch()');
eq(rgbToHex(parseColor('tomato')), '#ff6347', 'parse named');
eq(parseColor('not a color'), null, 'parse garbage -> null');
eq(parseColor(''), null, 'parse empty -> null');

for (const hex of ['#6ee7d7', '#0d1017', '#ff8800', '#123456', '#ffffff', '#000000', '#7f7f7f']) {
  eq(rgbToHex(hexToRgb(hex)), hex, `hex round-trip ${hex}`);
}

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
deep(tidyRuns([{ text: '  a   b  ' }]), [{ text: 'a b' }], 'collapses and trims plain spaces');

// Tabs and newlines must survive: collapsing them is what broke tabbed CVs.
eq(tidyRuns([{ text: 'A\tB' }])[0].text, 'A\tB', 'a tab is preserved, not collapsed');
eq(tidyRuns([{ text: 'A\t\tB' }])[0].text, 'A\t\tB', 'consecutive tabs are preserved');
eq(tidyRuns([{ text: 'A\nB' }])[0].text, 'A\nB', 'a newline is preserved');
eq(tidyRuns([{ text: 'A  \t  B' }])[0].text, 'A \t B', 'spaces around a tab still collapse');
deep(
  tidyRuns([{ text: 'a', href: 'https://x' }, { text: 'b', href: 'https://y' }]),
  [{ text: 'a', href: 'https://x' }, { text: 'b', href: 'https://y' }],
  'runs with different links stay separate',
);

{
  const blocks = parseBlocks('<h1>Title</h1><p>Body <strong>bold</strong> and <em>italic</em>.</p>');
  eq(blocks.length, 2, 'heading and paragraph parsed');
  eq(blocks[0].kind, 'heading', 'first block is a heading');
  eq(blocks[0].level, 1, 'h1 becomes level 1');
  eq(blockText(blocks[0]), 'Title', 'heading text');
  const styled = blocks[1].runs;
  ok(styled.some((r) => r.bold && r.text === 'bold'), 'bold run preserved');
  ok(styled.some((r) => r.italic && r.text === 'italic'), 'italic run preserved');
}

eq(parseBlocks('<h2>A</h2>')[0].level, 2, 'h2 becomes level 2');
eq(parseBlocks('<h6>A</h6>')[0].level, 3, 'h6 clamps to level 3');

// Inline formatting that mammoth does emit, and that used to be discarded.
ok(parseBlocks('<p><u>x</u></p>')[0].runs[0].underline, 'underline is captured');
ok(parseBlocks('<p><s>x</s></p>')[0].runs[0].strike, 'strikethrough is captured');
ok(parseBlocks('<p><del>x</del></p>')[0].runs[0].strike, 'del counts as strikethrough');
eq(parseBlocks('<p>H<sup>2</sup>O</p>')[0].runs[1].script, 'super', 'superscript is captured');
eq(parseBlocks('<p>x<sub>1</sub></p>')[0].runs[1].script, 'sub', 'subscript is captured');
eq(
  parseBlocks('<p><a href="https://example.com">link</a></p>')[0].runs[0].href,
  'https://example.com',
  'a hyperlink target is captured',
);
eq(
  parseBlocks('<p><a href="mailto:a@b.co">mail</a></p>')[0].runs[0].href,
  'mailto:a@b.co',
  'a mailto link is captured',
);
eq(
  parseBlocks('<p><a href="#bookmark">internal</a></p>')[0].runs[0].href,
  undefined,
  'an internal bookmark is not treated as a followable link',
);
eq(blockText(parseBlocks('<p><a href="#x">text survives</a></p>')[0]), 'text survives',
  'the text of an unusable link is still kept');
eq(parseBlocks('<p>A<br />B</p>')[0].runs[0].text, 'A\nB', 'a soft break becomes a real newline');

{
  const blocks = parseBlocks('<ul><li>one</li><li>two</li></ul>');
  eq(blocks.length, 2, 'two list items');
  eq(blocks[0].ordered, false, 'ul is unordered');
  eq(blocks[0].marker, '•', 'level-1 bullet');
}
{
  const blocks = parseBlocks('<ol><li>one</li><li>two</li><li>three</li></ol>');
  deep(blocks.map((b) => b.marker), ['1.', '2.', '3.'], 'ol numbers its items in order');
}
{
  // Word cycles 1. then a. then i. by depth; mammoth only gives nesting.
  const blocks = parseBlocks('<ol><li>A<ol><li>B<ol><li>C</li></ol></li></ol></li></ol>');
  deep(blocks.map((b) => b.marker), ['1.', 'a.', 'i.'], 'nested ordered lists use 1. / a. / i.');
  deep(blocks.map((b) => b.level), [1, 2, 3], 'nesting depth is recorded');
}
{
  const blocks = parseBlocks('<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>');
  deep(blocks.map((b) => b.marker), ['•', 'o', '-'], 'nested bullets cycle within WinAnsi');
  deep(unsupportedCharacters(blocks), [], 'and none of those bullets is unsupported');
}

eq(letters(1), 'a', 'letters 1');
eq(letters(26), 'z', 'letters 26');
eq(letters(27), 'aa', 'letters 27');
eq(roman(1), 'i', 'roman 1');
eq(roman(4), 'iv', 'roman 4');
eq(roman(9), 'ix', 'roman 9');
eq(roman(14), 'xiv', 'roman 14');
eq(orderedMarker(1, 3), '3.', 'depth 1 is decimal');
eq(orderedMarker(2, 3), 'c.', 'depth 2 is lettered');
eq(orderedMarker(3, 3), 'iii.', 'depth 3 is roman');
eq(orderedMarker(4, 3), '3.', 'depth 4 cycles back to decimal');

{
  const blocks = parseBlocks('<table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>');
  eq(blocks[0].kind, 'table', 'parsed as a table');
  eq(blocks[0].rows[0].length, 2, 'two cells');
  eq(blocks[0].rows[0][0].runs[0].text, 'A', 'cell content preserved');
  eq(blocks[0].rows[0][0].span, 1, 'a plain cell spans one column');
}
{
  // colspan is the one merge mammoth does translate.
  const blocks = parseBlocks('<table><tr><td colspan="3"><p>Wide</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td><td><p>c</p></td></tr></table>');
  eq(blocks[0].rows[0][0].span, 3, 'colspan is captured');
  eq(tableColumns(blocks[0].rows), 3, 'the table is three columns wide');
}
eq(
  parseBlocks('<table><tr><td colspan="0"><p>x</p></td></tr></table>')[0].rows[0][0].span,
  1,
  'a nonsense colspan falls back to 1',
);
eq(
  parseBlocks('<table><tr><th><p>H</p></th></tr></table>')[0].rows[0][0].runs[0].text,
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

eq(nextTabStop(0), 36, 'the first tab stop is at 36pt');
eq(nextTabStop(10), 36, 'a tab from 10pt lands on 36pt');
eq(nextTabStop(36), 72, 'a tab exactly on a stop advances to the next');
eq(nextTabStop(40), 72, 'a tab from 40pt lands on 72pt');
eq(nextTabStop(10, 20), 20, 'the stop interval is configurable');

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

// Tabs: the fix for right-aligned dates in a CV.
{
  const lines = wrapRuns([{ text: 'AB\tCD' }], 10, 400, half);
  eq(lines.length, 1, 'a tab does not break the line');
  const cd = lines[0].pieces.find((p) => p.text === 'CD');
  eq(cd.x, 36, 'text after a tab starts at the next tab stop, not one space along');
}
{
  const lines = wrapRuns([{ text: 'AB\t\tCD' }], 10, 400, half);
  eq(lines[0].pieces.find((p) => p.text === 'CD').x, 72, 'two tabs advance two stops');
}
{
  // A tab that would leave the line wraps instead of overflowing.
  const lines = wrapRuns([{ text: 'AB\tCD' }], 10, 30, half);
  ok(lines.length >= 2, 'a tab past the line width wraps');
}
{
  const lines = wrapRuns([{ text: 'A\nB' }], 10, 400, half);
  eq(lines.length, 2, 'a newline forces a line break');
  eq(lines[0].pieces[0].text, 'A', 'first line before the break');
  eq(lines[1].pieces[0].text, 'B', 'second line after it');
}
{
  // Super/subscript is measured smaller, so following text is not pushed out.
  const lines = wrapRuns([{ text: 'H' }, { text: '2', script: 'super' }, { text: 'O' }], 10, 400, half);
  const sup = lines[0].pieces.find((p) => p.script === 'super');
  ok(sup.size < 10, `superscript is drawn smaller (${sup.size})`);
  ok(sup.rise > 0, 'superscript is raised');
  ok(lines[0].pieces.find((p) => p.text === 'O').x < 10 + 5, 'the following text is not pushed out by a full-size digit');
}
{
  const lines = wrapRuns([{ text: 'x', script: 'sub' }], 10, 400, half);
  ok(lines[0].pieces[0].rise < 0, 'subscript is lowered');
}
{
  const lines = wrapRuns([{ text: 'link', href: 'https://x' }], 10, 400, half);
  eq(lines[0].pieces[0].href, 'https://x', 'the link target reaches the piece');
  ok(lines[0].pieces[0].width > 0, 'and the piece carries a width, so a rule and hotspot can be drawn');
}
{
  const lines = wrapRuns([{ text: 'u', underline: true }, { text: 's', strike: true }], 10, 400, half);
  ok(lines[0].pieces.some((p) => p.underline), 'underline reaches the piece');
  ok(lines[0].pieces.some((p) => p.strike), 'strikethrough reaches the piece');
}

deep(columnWidths(2, 108, 8), [50, 50], 'two columns split the width minus the gap');
eq(columnWidths(3, 200, 10).length, 3, 'three columns');
ok(columnWidths(20, 100, 8).every((w) => w >= 24), 'columns never collapse below a floor');
deep(columnWidths(0, 100), [], 'zero columns yields nothing');

eq(tableColumns([[{ runs: [], span: 1 }, { runs: [], span: 1 }]]), 2, 'two plain cells is two columns');
eq(tableColumns([[{ runs: [], span: 3 }]]), 3, 'one cell spanning three is three columns');
eq(tableColumns([]), 1, 'an empty table still has one column');
eq(spanWidth([50, 50, 50], 0, 1, 8), 50, 'a single column is its own width');
eq(spanWidth([50, 50, 50], 0, 2, 8), 108, 'spanning two columns swallows the gap between them');
eq(spanWidth([50, 50, 50], 0, 3, 8), 166, 'spanning three swallows two gaps');

{
  const many = Array.from({ length: 60 }, () => ({
    kind: 'paragraph',
    runs: [{ text: 'This is a paragraph with enough words in it to occupy a couple of lines each time.' }],
  }));
  const pages = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure: half });
  ok(pages.length > 1, `long input paginates (${pages.length} pages)`);

  const drawn = pages
    .flatMap((p) => p.items)
    .filter((i) => i.kind === 'line')
    .flatMap((i) => i.line.pieces)
    .map((p) => p.text)
    .join(' ');
  eq((drawn.match(/paragraph/g) ?? []).length, 60, 'every paragraph survives pagination');

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
  const pages = layout([{ kind: 'table', rows: [[{ runs: [{ text: 'A' }], span: 1 }, { runs: [{ text: 'B' }], span: 1 }]] }], {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure: half,
  });
  eq(pages[0].items.filter((i) => i.kind === 'cellBox').length, 2, 'a table row draws one box per cell');
}
{
  // A merged cell must be drawn wider than a single column, not left narrow.
  const pages = layout(
    [
      {
        kind: 'table',
        rows: [
          [{ runs: [{ text: 'Wide' }], span: 3 }],
          [
            { runs: [{ text: 'a' }], span: 1 },
            { runs: [{ text: 'b' }], span: 1 },
            { runs: [{ text: 'c' }], span: 1 },
          ],
        ],
      },
    ],
    { geometry: A4, scale: DEFAULT_SCALE, measure: half },
  );
  const boxes = pages[0].items.filter((i) => i.kind === 'cellBox');
  eq(boxes.length, 4, 'four cell boxes in total');
  const wide = boxes[0];
  const narrow = boxes[1];
  ok(wide.width > narrow.width * 2.5, `the merged cell spans the row (${wide.width.toFixed(0)} vs ${narrow.width.toFixed(0)})`);
  ok(
    Math.abs(wide.width - (A4.width - A4.margin * 2)) < 2,
    'and fills the full text width',
  );
}

/* -------------------------------------------------------- docx: word xml */

eq(twips('1440'), 72, '1440 twips is one inch (72pt)');
eq(twips('720'), 36, '720 twips is half an inch');
eq(twips(undefined), 0, 'a missing measurement is zero');
eq(twips('nonsense'), 0, 'an unparseable measurement is zero');

const wp = (inner) =>
  `<w:document xmlns:w="x"><w:body>${inner}</w:body></w:document>`;

// Alignment
{
  const props = readParagraphProps(
    wp(
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>C</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>R</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>J</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>P</w:t></w:r></w:p>',
    ),
  );
  eq(props.length, 4, 'four paragraphs read');
  eq(props[0].align, 'center', 'w:jc center');
  eq(props[1].align, 'right', 'w:jc right');
  eq(props[2].align, 'justify', 'w:jc both becomes justify');
  eq(props[3].align, undefined, 'a paragraph with no w:jc has no alignment');
}

// Size, in half-points
{
  const props = readParagraphProps(
    wp('<w:p><w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:t>Big</w:t></w:r></w:p><w:p><w:r><w:t>Plain</w:t></w:r></w:p>'),
  );
  eq(props[0].size, 24, 'w:sz 48 half-points is 24pt');
  eq(props[1].size, undefined, 'no w:sz means no override');
}
eq(
  readParagraphProps(wp('<w:p><w:r><w:rPr><w:sz w:val="99999"/></w:rPr><w:t>x</w:t></w:r></w:p>'))[0].size,
  undefined,
  'an absurd size is ignored rather than trusted',
);

// Indents
{
  const props = readParagraphProps(
    wp(
      '<w:p><w:pPr><w:ind w:left="720" w:firstLine="360"/></w:pPr><w:r><w:t>A</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:r><w:t>B</w:t></w:r></w:p>',
    ),
  );
  eq(props[0].indent, 36, 'left indent in points');
  eq(props[0].firstLine, 18, 'first-line indent in points');
  eq(props[1].firstLine, -18, 'a hanging indent is a negative first-line offset');
}

// Tab stops — the CV case
{
  const props = readParagraphProps(
    wp(
      '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/><w:tab w:val="left" w:pos="2880"/></w:tabs></w:pPr>' +
        '<w:r><w:t>Role</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>2024</w:t></w:r></w:p>',
    ),
  );
  eq(props[0].tabs.length, 2, 'both stops read');
  eq(props[0].tabs[0].pos, 144, 'stops are sorted by position, nearest first');
  eq(props[0].tabs[1].pos, 450, 'the right stop is at 450pt');
  eq(props[0].tabs[1].align, 'right', 'and is a right stop');
  eq(props[0].text, 'Role\t2024', 'the tab survives into the comparison text');
}
eq(
  readParagraphProps(wp('<w:p><w:pPr><w:tabs><w:tab w:val="clear" w:pos="100"/></w:tabs></w:pPr><w:r><w:t>x</w:t></w:r></w:p>'))[0].tabs,
  undefined,
  'a "clear" stop removes rather than declares, so it is skipped',
);

// Paragraph text, used only for correlation
eq(paragraphText('<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r></w:p>'), 'A\tB', 'tab becomes \\t');
eq(paragraphText('<w:p><w:r><w:t>A</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>B</w:t></w:r></w:p>'), 'A\nB', 'break becomes \\n');
eq(paragraphText('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>'), 'a & b', 'entities are decoded');
eq(paragraphText('<w:p><w:r><w:t xml:space="preserve"> x </w:t></w:r></w:p>'), ' x ', 'preserved spaces are kept');
eq(normalizeText('  a   b '), 'a b', 'normalizeText flattens whitespace');

// Table paragraphs must be excluded or every later index shifts
{
  const xml = wp(
    '<w:p><w:r><w:t>Before</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>InCell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>After</w:t></w:r></w:p>',
  );
  const props = readParagraphProps(xml);
  deep(props.map((p) => p.text), ['Before', 'After'], 'paragraphs inside a table are not counted');
  ok(!withoutTables(xml).includes('InCell'), 'withoutTables strips the table region');
}

// Page setup
{
  const setup = readPageSetup(
    wp('<w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'),
  );
  ok(Math.abs(setup.width - 595.3) < 1, `A4 width read (${setup.width.toFixed(1)}pt)`);
  ok(Math.abs(setup.height - 841.9) < 1, `A4 height read (${setup.height.toFixed(1)}pt)`);
  eq(setup.margin, 72, 'one-inch margins read');
}
{
  const setup = readPageSetup(
    wp('<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>'),
  );
  ok(setup.width > setup.height, 'landscape comes back wider than tall');
}
{
  // A wide binding edge must not crush the text column.
  const setup = readPageSetup(
    wp('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:left="5000" w:right="720" w:bottom="720"/></w:sectPr>'),
  );
  eq(setup.margin, 36, 'the smallest margin is used, not the binding edge');
}
eq(readPageSetup(wp('<w:p/>')), null, 'no sectPr means no page setup');
eq(readPageSetup(wp('<w:sectPr><w:pgSz w:w="10" w:h="10"/></w:sectPr>')), null, 'an implausible page size is rejected');

// Correlation by text, not position
{
  const blocks = [
    { kind: 'paragraph', runs: [{ text: 'One' }] },
    { kind: 'heading', runs: [{ text: 'Two' }] },
    { kind: 'table', rows: [] },
    { kind: 'paragraph', runs: [{ text: 'Three' }] },
  ];
  const props = [
    { text: 'One', align: 'center' },
    { text: 'Two', align: 'right' },
    { text: 'Three', align: 'justify' },
  ];
  const { applied, skipped, attach } = correlate(blocks, props);
  eq(applied, 3, 'all three text blocks matched');
  eq(skipped, 0, 'nothing skipped');
  eq(attach(blocks[0]).align, 'center', 'first block got its own properties');
  eq(attach(blocks[1]).align, 'right', 'second block matched past the table block');
  eq(attach(blocks[3]).align, 'justify', 'third block matched');
  eq(attach(blocks[2]), undefined, 'the table block gets nothing');
}
{
  // A drifted document must degrade to defaults, not misformat.
  const blocks = [{ kind: 'paragraph', runs: [{ text: 'Totally different' }] }];
  const { applied, skipped, attach } = correlate(blocks, [{ text: 'Nothing alike', align: 'right' }]);
  eq(applied, 0, 'no match means nothing applied');
  eq(skipped, 1, 'and the miss is counted');
  eq(attach(blocks[0]), undefined, 'so the block keeps the defaults');
}
{
  // mammoth drops empty paragraphs the XML still contains.
  const blocks = [{ kind: 'paragraph', runs: [{ text: 'Real' }] }];
  const { applied, attach } = correlate(blocks, [
    { text: '' }, { text: '' }, { text: 'Real', align: 'center' },
  ]);
  eq(applied, 1, 'it looks ahead past empty paragraphs');
  eq(attach(blocks[0]).align, 'center', 'and still finds the match');
}

/* ------------------------------------------------- docx: align and tabs */

{
  // A right tab stop must make the following text END on the stop.
  const tabs = [{ pos: 200, align: 'right' }];
  const lines = wrapRuns([{ text: 'Role\t2024' }], 10, 400, half, tabs);
  eq(lines.length, 1, 'the tabbed line stays on one line');
  const date = lines[0].pieces.find((p) => p.text === '2024');
  ok(
    Math.abs(date.x + date.width - 200) < 0.01,
    `the date ends exactly on the right stop (ends at ${(date.x + date.width).toFixed(1)})`,
  );
}
{
  // A left stop simply starts there.
  const lines = wrapRuns([{ text: 'A\tB' }], 10, 400, half, [{ pos: 150, align: 'left' }]);
  eq(lines[0].pieces.find((p) => p.text === 'B').x, 150, 'a left stop positions the start');
}
{
  // With no declared stops, the half-inch grid still applies.
  const lines = wrapRuns([{ text: 'A\tB' }], 10, 400, half, []);
  eq(lines[0].pieces.find((p) => p.text === 'B').x, 36, 'no stops falls back to the default grid');
}

{
  const line = wrapRuns([{ text: 'abcd' }], 10, 200, half)[0];
  eq(lineWidth(line), 20, 'lineWidth measures to the end of the last piece');

  const centred = alignLine(line, 'center', 200, true);
  eq(centred.pieces[0].x, 90, 'centring offsets by half the slack');

  const right = alignLine(line, 'right', 200, true);
  eq(right.pieces[0].x, 180, 'right alignment pushes to the far edge');

  const left = alignLine(line, 'left', 200, true);
  eq(left.pieces[0].x, 0, 'left alignment changes nothing');
}
{
  // Justify stretches the spaces, but never on the last line.
  const line = wrapRuns([{ text: 'aa bb cc' }], 10, 200, half)[0];
  const justified = alignLine(line, 'justify', 48, false);
  ok(lineWidth(justified) > lineWidth(line), 'justify widens the line towards the margin');
  const last = alignLine(line, 'justify', 48, true);
  eq(lineWidth(last), lineWidth(line), 'the last line of a block is left ragged');
}
{
  // An absurd stretch is worse than a ragged edge.
  const line = wrapRuns([{ text: 'a b' }], 10, 400, half)[0];
  eq(lineWidth(alignLine(line, 'justify', 400, false)), lineWidth(line), 'a huge gap is left alone');
}

{
  // The appearance callback must actually move things.
  const blocks = [{ kind: 'paragraph', runs: [{ text: 'centre me' }] }];
  const plain = layout(blocks, { geometry: A4, scale: DEFAULT_SCALE, measure: half });
  const centred = layout(blocks, {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure: half,
    appearance: () => ({ align: 'center' }),
  });
  const xOf = (pages) => pages[0].items.find((i) => i.kind === 'line').line.pieces[0].x;
  ok(xOf(centred) > xOf(plain), 'a centred paragraph starts further right');
}
{
  const blocks = [{ kind: 'paragraph', runs: [{ text: 'indent me' }] }];
  const shifted = layout(blocks, {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure: half,
    appearance: () => ({ indent: 40 }),
  });
  const line = shifted[0].items.find((i) => i.kind === 'line');
  ok(Math.abs(line.x - (A4.margin + 40)) < 0.01, 'an indent moves the whole block right');
}
{
  const blocks = [{ kind: 'paragraph', runs: [{ text: 'big text' }] }];
  const big = layout(blocks, {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure: half,
    appearance: () => ({ size: 24 }),
  });
  eq(big[0].items.find((i) => i.kind === 'line').line.size, 24, 'a size override reaches the line');
}

/* -------------------------------------------------------------------- end */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
