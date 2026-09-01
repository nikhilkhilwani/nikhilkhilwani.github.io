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
  wrapRuns, layout, columnWidths, A4, DEFAULT_SCALE, nextTabStop, tableColumns, spanWidth, columnOffset,
  alignLine, lineWidth,
} from '../src/lib/docx/layout.ts';
import {
  scriptKeyFor, scriptsIn, segmentByScript, scriptFont, SCRIPT_FONTS, RTL_SCRIPTS, LATIN,
} from '../src/lib/docx/scripts.ts';
import { readImageExtents, intrinsicSize, EMU } from '../src/lib/docx/wordxml.ts';
import {
  readRunSpans, applyRunSpans, alignOffsets, hexToUnitRgb, readTableCellRuns,
} from '../src/lib/docx/runs.ts';
import {
  readRelationships, readFurnitureRefs, substituteFields, parseFurniture,
  parseParagraphBlocks, readTextBoxes,
} from '../src/lib/docx/furniture.ts';
import { reorderTokens } from '../src/lib/docx/bidi.ts';
import {
  splitLines, splitWords, normaliseLine, diffLines, applyEdits, diffWords, compareTexts,
  DEFAULT_MAX_EDITS,
} from '../src/lib/text/diff.ts';
import { toUnifiedDiff, countHunks } from '../src/lib/text/patch.ts';
import {
  splitNotes, markersIn, markerId, backReferenceId,
} from '../src/lib/docx/footnotes.ts';
import bidiFactory from 'bidi-js';
import {
  twips, readParagraphProps, readPageSetup, correlate, paragraphText, normalizeText, withoutTables, readStyles,
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

/* --- column offsets: cells used to be drawn on top of each other --- */

// spanWidth clamps its span to at least one column, so reusing it to compute an
// offset gave column 0 a full column of indent. Every table's first cell landed
// 8pt from the second and the pair overlapped illegibly, while extraction still
// returned both strings — which is why no existing assertion noticed.
eq(columnOffset([50, 50, 50], 0, 8), 0, 'the first column starts at the text edge');
eq(columnOffset([50, 50, 50], 1, 8), 58, 'the second column clears the first plus the gap');
eq(columnOffset([50, 50, 50], 2, 8), 116, 'the third clears two columns and two gaps');
eq(columnOffset([50, 50, 50], -1, 8), 0, 'a negative start is treated as the first column');

{
  // The whole point: laid-out cells must not overlap, and the row must span the
  // full text width without spilling past the right margin.
  const table = {
    kind: 'table',
    rows: [
      [
        { runs: [{ text: 'Region' }], span: 1 },
        { runs: [{ text: 'Growth' }], span: 1 },
      ],
    ],
  };
  const pages = layout([table], { geometry: A4, scale: DEFAULT_SCALE, measure: (t, st) => t.length * st.size * 0.5 });
  const boxes = pages[0].items.filter((i) => i.kind === 'cellBox');
  eq(boxes.length, 2, 'both cells produced a box');
  eq(Math.round(boxes[0].x), A4.margin, 'the first cell sits on the left margin');
  ok(
    boxes[0].x + boxes[0].width <= boxes[1].x + 0.01,
    `cells do not overlap (first ends ${(boxes[0].x + boxes[0].width).toFixed(1)}, second starts ${boxes[1].x.toFixed(1)})`,
  );
  ok(
    boxes[1].x + boxes[1].width <= A4.width - A4.margin + 0.01,
    'the last cell stays inside the right margin',
  );

  const lines = pages[0].items.filter((i) => i.kind === 'line');
  eq(lines.length, 2, 'both cells drew a line of text');
  ok(Math.abs(lines[0].x - lines[1].x) > 40, 'the two cell texts are drawn far apart, not stacked');
}

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


/* ---------------------------------------------- script detection and splitting */

eq(scriptKeyFor(0x41), LATIN, 'A is Latin');
eq(scriptKeyFor(0x0416), LATIN, 'Cyrillic Zh is served by Carlito, so it counts as Latin');
eq(scriptKeyFor(0x03b1), LATIN, 'Greek alpha is served by Carlito');
eq(scriptKeyFor(0x0928), 'devanagari', 'na is Devanagari');
eq(scriptKeyFor(0x0964), 'devanagari', 'the danda is Devanagari');
eq(scriptKeyFor(0x09aa), 'bengali', 'Bengali pa');
eq(scriptKeyFor(0x0ba4), 'tamil', 'Tamil ta');
eq(scriptKeyFor(0x0627), 'arabic', 'Arabic alef');
eq(scriptKeyFor(0xfe8d), 'arabic', 'an Arabic presentation form still resolves to Arabic');
eq(scriptKeyFor(0x05d0), 'hebrew', 'Hebrew alef');
eq(scriptKeyFor(0x0e01), 'thai', 'Thai ko kai');
eq(scriptKeyFor(0x4e2d), LATIN, 'CJK has no font here, so it falls through to Latin and gets reported');

// Every declared script must have a file, a label and at least one range, or a
// document using it would load nothing and silently render "?".
for (const font of SCRIPT_FONTS) {
  ok(font.file.endsWith('.ttf'), `${font.key}: names a .ttf`);
  ok(font.label.length > 0, `${font.key}: has a human-readable label`);
  ok(font.ranges.length > 0, `${font.key}: declares at least one range`);
  eq(scriptFont(font.key), font, `${font.key}: is findable by key`);
  // Its own first codepoint must resolve back to it — catches a range typo.
  eq(scriptKeyFor(font.ranges[0][0]), font.key, `${font.key}: its first codepoint maps back`);
}
ok(RTL_SCRIPTS.has('arabic') && RTL_SCRIPTS.has('hebrew'), 'Arabic and Hebrew are marked right-to-left');
ok(!RTL_SCRIPTS.has('devanagari'), 'Devanagari is not right-to-left');

deep([...scriptsIn('plain english')], [], 'a Latin string reports no extra scripts');
deep([...scriptsIn('hello नमस्ते')], ['devanagari'], 'a mixed string reports the script it needs');
eq(scriptsIn('नमस्ते مرحبا').size, 2, 'two scripts are both reported');

/* --- segmentByScript: the cut points that shaping depends on --- */

deep(segmentByScript(''), [], 'an empty string yields no segments');
eq(segmentByScript('Hello world').length, 1, 'pure Latin is a single segment');

{
  const segs = segmentByScript('Hindi: नमस्ते');
  eq(segs.length, 2, 'Latin then Devanagari is two segments');
  eq(segs[0]?.script, LATIN, 'the first segment is Latin');
  eq(segs[1]?.script, 'devanagari', 'the second is Devanagari');
  eq(segs.map((x) => x.text).join(''), 'Hindi: नमस्ते', 'segmentation loses no characters');
}

// The rule that matters most: a cluster must never be cut, or the matra
// detaches and the conjunct falls apart when it is drawn.
eq(segmentByScript('नि').length, 1, 'a consonant plus its matra stays one segment');
eq(segmentByScript('क्ष').length, 1, 'a conjunct stays one segment');
eq(segmentByScript('न‍म').length, 1, 'a zero-width joiner does not split a Devanagari cluster');
eq(segmentByScript('न‌म').length, 1, 'a zero-width non-joiner does not split one either');

{
  // A space between two Hindi words must not force a font switch.
  const segs = segmentByScript('नमस्ते दुनिया');
  eq(segs.length, 1, 'a space inside Hindi keeps it one segment');
  eq(segs[0]?.script, 'devanagari', 'and that segment is Devanagari');
}

{
  // A leading space belongs to what follows it, not to a stray Latin segment.
  const segs = segmentByScript(' नमस्ते');
  eq(segs.length, 1, 'a leading space joins the script that follows');
  eq(segs[0]?.script, 'devanagari', 'so the whole thing is Devanagari');
}

eq(segmentByScript('  ').length, 1, 'only-neutral text still yields one segment');
eq(segmentByScript('  ')[0]?.script, LATIN, 'and it defaults to Latin');

{
  const segs = segmentByScript('a नमस्ते b مرحبا');
  eq(segs.length, 4, 'three scripts across four alternating segments');
  deep(segs.map((x) => x.script), [LATIN, 'devanagari', LATIN, 'arabic'], 'in document order');
}

/* --- wrapRuns tags every piece with the font that must draw it --- */

{
  const measure = (text, style) => text.length * style.size * (style.font === LATIN ? 0.5 : 0.6);
  const lines = wrapRuns([{ text: 'Hindi: नमस्ते' }], 11, 400, measure);
  const pieces = lines.flatMap((l) => l.pieces);
  ok(pieces.length >= 2, `the mixed run produced ${pieces.length} pieces`);
  ok(pieces.every((piece) => typeof piece.font === 'string' && piece.font.length > 0), 'every piece names a font');
  ok(pieces.some((piece) => piece.font === LATIN), 'at least one piece is Latin');
  ok(pieces.some((piece) => piece.font === 'devanagari'), 'at least one piece is Devanagari');
  // No piece may mix scripts, because one piece is one drawText call.
  for (const piece of pieces) {
    const scripts = new Set(segmentByScript(piece.text).map((x) => x.script));
    ok(scripts.size <= 1, `piece ${JSON.stringify(piece.text)} is single-script`);
  }
}

{
  // List markers are Latin whatever the item's language is.
  const measure = (text, style) => text.length * style.size * 0.5;
  const pages = layout(
    [{ kind: 'listItem', level: 1, marker: '•', ordered: false, runs: [{ text: 'नमस्ते' }] }],
    { geometry: A4, scale: DEFAULT_SCALE, measure },
  );
  const pieces = pages[0].items.filter((i) => i.kind === 'line').flatMap((i) => i.line.pieces);
  const marker = pieces.find((piece) => piece.text === '•');
  ok(marker !== undefined, 'the bullet marker was drawn');
  eq(marker?.font, LATIN, 'the bullet is drawn with the Latin face, not the Devanagari one');
}


/* ------------------------------------------------ image sizing: the 8-page resume */

// A real resume converted to 8 pages instead of 2. Its section dividers are
// images 508 x 1 pt, but layout knew no size and reserved the full text width at
// a hardcoded 4:3 ratio - about 425pt each. Eight rules, four blank pages.

{
  const emu = (pt) => Math.round(pt * EMU);
  const drawing = (w, h) => `<w:drawing><wp:anchor><wp:extent cx="${emu(w)}" cy="${emu(h)}"/></wp:anchor></w:drawing>`;

  const xml = `<w:body>${drawing(508.4, 1)}${drawing(120, 90)}</w:body>`;
  const extents = readImageExtents(xml);
  eq(extents.length, 2, 'two extents read');
  ok(Math.abs(extents[0].width - 508.4) < 0.1, `first extent width ${extents[0].width.toFixed(1)}pt`);
  ok(Math.abs(extents[0].height - 1) < 0.05, `first extent height ${extents[0].height.toFixed(2)}pt - a hairline rule`);
  ok(Math.abs(extents[1].height - 90) < 0.1, 'second extent height 90pt');

  // mc:AlternateContent holds the same drawing twice, once per branch. Counting
  // raw <wp:extent> returns double and every image takes the NEXT one's size.
  const alt =
    `<w:body><mc:AlternateContent><mc:Choice>${drawing(508.4, 1)}</mc:Choice>` +
    `<mc:Fallback>${drawing(999, 999)}</mc:Fallback></mc:AlternateContent></w:body>`;
  const deduped = readImageExtents(alt);
  eq(deduped.length, 1, 'an mc:AlternateContent drawing is counted once, not twice');
  ok(Math.abs(deduped[0].height - 1) < 0.05, 'and it is the Choice branch size, not the Fallback');

  eq(readImageExtents('<w:body/>').length, 0, 'a document with no drawings yields no extents');
}

{
  // intrinsicSize reads the header only, so a hand-built PNG signature+IHDR is
  // a complete fixture.
  const png = (w, h) => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
    for (const v of [w, h]) bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    while (bytes.length < 33) bytes.push(0);
    return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
  };

  const size = intrinsicSize(png(96, 48));
  ok(size !== null, 'a PNG header is understood');
  // 96 CSS pixels at 96dpi is one inch, which is 72pt.
  ok(Math.abs(size.width - 72) < 0.01, `96px wide becomes ${size.width.toFixed(1)}pt`);
  ok(Math.abs(size.height - 36) < 0.01, `48px tall becomes ${size.height.toFixed(1)}pt`);

  eq(intrinsicSize('not-a-data-uri'), null, 'a non-data-uri yields null rather than throwing');
  eq(intrinsicSize('data:image/webp;base64,AAAA'), null, 'an unreadable format yields null');
}

{
  const measure = (text, style) => text.length * style.size * 0.5;
  const rule = { kind: 'image', dataUri: 'data:image/png;base64,AAAA', width: 508.4, height: 1 };

  const sized = layout([rule], { geometry: A4, scale: DEFAULT_SCALE, measure });
  const img = sized[0].items.find((i) => i.kind === 'image');
  ok(img !== undefined, 'the rule was laid out');
  ok(Math.abs(img.height - 1) < 0.5, `a 1pt rule reserves ${img.height.toFixed(1)}pt, not a fifth of a page`);

  // Eight rules and a heading must still be one page. Before the fix this was
  // five pages, four of them blank.
  const eight = [];
  for (let i = 0; i < 8; i++) {
    eight.push({ kind: 'heading', level: 2, runs: [{ text: `Section ${i + 1}` }] });
    eight.push({ ...rule });
  }
  const pages = layout(eight, { geometry: A4, scale: DEFAULT_SCALE, measure });
  eq(pages.length, 1, `eight headings each followed by a hairline rule fit on one page (got ${pages.length})`);

  // An image wider than the column is scaled DOWN, keeping its aspect ratio.
  const wide = layout([{ kind: 'image', dataUri: 'data:,', width: 2000, height: 1000 }], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
  });
  const scaled = wide[0].items.find((i) => i.kind === 'image');
  ok(scaled.width <= A4.width - A4.margin * 2 + 0.01, 'an oversized image is capped to the text width');
  ok(Math.abs(scaled.width / scaled.height - 2) < 0.01, 'and keeps its 2:1 aspect ratio');

  // A small image is NOT blown up to fill the column.
  const small = layout([{ kind: 'image', dataUri: 'data:,', width: 40, height: 40 }], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
  });
  const kept = small[0].items.find((i) => i.kind === 'image');
  ok(Math.abs(kept.width - 40) < 0.01, `a 40pt icon stays 40pt wide (got ${kept.width.toFixed(1)})`);

  // With no declared size the old guess still applies - that is the fallback,
  // and it must not crash.
  const guessed = layout([{ kind: 'image', dataUri: 'data:,' }], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
  });
  ok(guessed.length >= 1, 'an image with no size at all still lays out');
}


/* ---------------------------------------------- paragraph spacing (w:spacing) */

// Ignoring w:spacing is what kept a single-spaced 2-page resume on 3 pages: Word
// asked for line=240 auto (exactly one line) with after=0, while the defaults
// here added 38% leading plus a gap before every paragraph.

{
  const para = (pPr, text) => `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const doc = (body) => `<w:document><w:body>${body}</w:body></w:document>`;

  const props = readParagraphProps(
    doc(
      para('<w:spacing w:after="0" w:before="62" w:line="240" w:lineRule="auto"/>', 'single') +
        para('<w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/>', 'one and a half') +
        para('<w:spacing w:line="300" w:lineRule="exact"/>', 'exact') +
        para('<w:spacing w:line="300" w:lineRule="atLeast"/>', 'at least') +
        para('<w:contextualSpacing/>', 'contextual on') +
        para('<w:contextualSpacing w:val="0"/>', 'contextual off') +
        para('', 'nothing declared'),
    ),
  );
  eq(props.length, 7, 'seven paragraphs read');

  // 62 twips is 3.1pt; after=0 must survive as 0, not be lost as falsy.
  ok(Math.abs(props[0].spaceBefore - 3.1) < 0.01, `before 62tw becomes ${props[0].spaceBefore}pt`);
  eq(props[0].spaceAfter, 0, 'after="0" is recorded as 0, not dropped');
  ok(Math.abs(props[0].lineMultiple - 1) < 0.001, 'line=240 auto is single spacing');

  ok(Math.abs(props[1].spaceBefore - 12) < 0.01, 'before 240tw becomes 12pt');
  ok(Math.abs(props[1].spaceAfter - 6) < 0.01, 'after 120tw becomes 6pt');
  ok(Math.abs(props[1].lineMultiple - 1.5) < 0.001, 'line=360 auto is one-and-a-half');

  ok(Math.abs(props[2].lineExact - 15) < 0.01, 'lineRule=exact gives a fixed 15pt');
  eq(props[2].lineAtLeast, false, 'and is explicitly not a floor');
  eq(props[2].lineMultiple, undefined, 'nor as a multiple');

  ok(Math.abs(props[3].lineExact - 15) < 0.01, 'lineRule=atLeast also gives 15pt');
  eq(props[3].lineAtLeast, true, 'but is marked as a floor');

  eq(props[4].contextualSpacing, true, '<w:contextualSpacing/> is on');
  eq(props[5].contextualSpacing, undefined, 'w:val="0" turns it off again');
  eq(props[6].spaceBefore, undefined, 'a paragraph declaring nothing reports nothing');
  eq(props[6].lineMultiple, undefined, 'and no line spacing either');
}

{
  const measure = (text, style) => text.length * style.size * 0.5;
  const long = { kind: 'paragraph', runs: [{ text: 'word '.repeat(40).trim() }] };

  // Single spacing must pack more lines onto a page than the roomier default.
  const asSingle = layout([long], {
    geometry: A4,
    scale: DEFAULT_SCALE,
    measure,
    appearance: () => ({ lineMultiple: 1 }),
  });
  const asDefault = layout([long], { geometry: A4, scale: DEFAULT_SCALE, measure });

  const spanOf = (pages) => {
    const ys = pages[0].items.filter((i) => i.kind === 'line').map((i) => i.y);
    return Math.max(...ys) - Math.min(...ys);
  };
  ok(
    spanOf(asSingle) < spanOf(asDefault),
    `single spacing is tighter than the default (${spanOf(asSingle).toFixed(1)}pt vs ${spanOf(asDefault).toFixed(1)}pt)`,
  );

  // singleLine is the font's own line height, so it drives that calculation.
  const wide = layout([long], {
    geometry: A4,
    scale: { ...DEFAULT_SCALE, singleLine: 2 },
    measure,
    appearance: () => ({ lineMultiple: 1 }),
  });
  ok(spanOf(wide) > spanOf(asSingle), 'a taller singleLine spreads the same lines further');

  // An exact line height is obeyed literally.
  const exact = layout([long], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
    appearance: () => ({ lineExact: 30 }),
  });
  const exactYs = exact[0].items.filter((i) => i.kind === 'line').map((i) => i.y);
  ok(exactYs.length >= 2, 'the exact-spaced paragraph wrapped');
  ok(Math.abs((exactYs[0] - exactYs[1]) - 30) < 0.01, 'baselines sit exactly 30pt apart');

  // atLeast is a floor: a small value must not squash the line.
  const floorish = layout([long], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
    appearance: () => ({ lineExact: 2, lineAtLeast: true }),
  });
  const floorYs = floorish[0].items.filter((i) => i.kind === 'line').map((i) => i.y);
  ok(floorYs[0] - floorYs[1] > 10, 'atLeast=2pt is raised to the font single line height');
}

{
  const measure = (text, style) => text.length * style.size * 0.5;
  const one = { kind: 'paragraph', runs: [{ text: 'short' }] };
  const two = { kind: 'paragraph', runs: [{ text: 'also short' }] };

  const gapBetween = (appearance) => {
    const pages = layout([one, two], { geometry: A4, scale: DEFAULT_SCALE, measure, appearance });
    const ys = pages[0].items.filter((i) => i.kind === 'line').map((i) => i.y);
    return ys[0] - ys[1];
  };

  const declared = gapBetween(() => ({ spaceBefore: 40, spaceAfter: 0 }));
  const none = gapBetween(() => ({ spaceBefore: 0, spaceAfter: 0 }));
  ok(declared > none + 30, `a 40pt spaceBefore opens the gap (${declared.toFixed(1)} vs ${none.toFixed(1)})`);

  // contextualSpacing drops the gap between two paragraphs of the same kind.
  const contextual = gapBetween(() => ({ spaceBefore: 40, contextualSpacing: true }));
  ok(
    contextual < declared - 30,
    `contextualSpacing suppresses it between like paragraphs (${contextual.toFixed(1)})`,
  );
}

{
  // Image padding scales with the image: a hairline rule must not carry 12pt of
  // air, which is what kept the resume from fitting on two pages.
  const measure = (text, style) => text.length * style.size * 0.5;
  const at = (height) => {
    const pages = layout([{ kind: 'image', dataUri: 'data:,', width: 500, height }], {
      geometry: A4, scale: DEFAULT_SCALE, measure,
    });
    const img = pages[0].items.find((i) => i.kind === 'image');
    // Space consumed above the image, from the top of the text area.
    return A4.height - A4.margin - (img.y + img.height);
  };
  ok(at(1) < 2, `a 1pt rule takes under 2pt of padding above it (${at(1).toFixed(2)}pt)`);
  ok(at(200) >= 5.9, `a 200pt image still gets full padding (${at(200).toFixed(2)}pt)`);
}


/* ------------------------------------------------------------ styles.xml */

// Headings used to be whatever size this tool guessed. The resume that exposed
// it declares Heading1 at 26pt centred and Heading2 at 11pt, with no direct
// formatting on the paragraphs at all - so the guess was simply wrong.

{
  const style = (id, body, basedOn) =>
    `<w:style w:type="paragraph" w:styleId="${id}">` +
    (basedOn ? `<w:basedOn w:val="${basedOn}"/>` : '') +
    body +
    '</w:style>';

  const xml =
    '<w:styles>' +
    // docDefaults must be ignored: the tool has a body-size slider, and a
    // Heading style with no size would otherwise inherit the body size.
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="40"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:before="999"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    style('Normal', '<w:pPr><w:spacing w:after="120"/></w:pPr>') +
    style('Heading1', '<w:pPr><w:jc w:val="center"/><w:spacing w:before="65"/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr>') +
    style('Sub', '<w:pPr><w:ind w:left="720"/></w:pPr>', 'Heading1') +
    style('CharOnly', '<w:rPr><w:sz w:val="99"/></w:rPr>').replace('w:type="paragraph"', 'w:type="character"') +
    '</w:styles>';

  const defs = readStyles(xml);

  eq(defs.byId.get('Heading1').size, 26, 'Heading1 sz=52 half-points becomes 26pt');
  eq(defs.byId.get('Heading1').align, 'center', 'Heading1 is centred');
  ok(Math.abs(defs.byId.get('Heading1').spaceBefore - 3.25) < 0.01, 'Heading1 before 65tw is 3.25pt');
  ok(Math.abs(defs.byId.get('Normal').spaceAfter - 6) < 0.01, 'Normal after 120tw is 6pt');

  // basedOn is flattened, and the child's own values win.
  const sub = defs.byId.get('Sub');
  eq(sub.size, 26, 'Sub inherits its size from Heading1 via basedOn');
  eq(sub.align, 'center', 'and its alignment');
  ok(Math.abs(sub.indent - 36) < 0.01, 'while keeping its own 720tw indent');

  eq(defs.byId.has('CharOnly'), false, 'a character style is not a paragraph style');
  eq(defs.byId.get('Normal').size, undefined, 'docDefaults sz is NOT applied - the size slider must survive');
  eq(defs.byId.get('Normal').spaceBefore, undefined, 'nor is docDefaults spacing');

  // A basedOn cycle must not hang.
  const cyclic = readStyles(
    '<w:styles>' + style('A', '', 'B') + style('B', '', 'A') + '</w:styles>',
  );
  eq(cyclic.byId.size, 2, 'a basedOn cycle resolves rather than looping forever');

  eq(readStyles('<w:styles/>').byId.size, 0, 'an empty styles part yields nothing');
}

{
  // Style values seed a paragraph; anything it states directly overrides them.
  const styles = readStyles(
    '<w:styles><w:style w:type="paragraph" w:styleId="H">' +
      '<w:pPr><w:jc w:val="center"/><w:spacing w:before="200" w:after="100"/></w:pPr>' +
      '<w:rPr><w:sz w:val="40"/></w:rPr></w:style></w:styles>',
  );
  const doc = (pPr, text) =>
    `<w:document><w:body><w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

  const inherited = readParagraphProps(doc('<w:pStyle w:val="H"/>', 'x'), styles)[0];
  eq(inherited.styleId, 'H', 'the style id is recorded');
  eq(inherited.size, 20, 'the size comes from the style');
  eq(inherited.align, 'center', 'so does the alignment');
  ok(Math.abs(inherited.spaceBefore - 10) < 0.01, 'and the spacing');

  const overridden = readParagraphProps(
    doc('<w:pStyle w:val="H"/><w:jc w:val="right"/><w:spacing w:before="0"/>', 'x'),
    styles,
  )[0];
  eq(overridden.align, 'right', 'a direct w:jc beats the style');
  eq(overridden.spaceBefore, 0, 'a direct before=0 beats the style, and survives as 0');
  eq(overridden.size, 20, 'the style size still applies where nothing overrides it');

  const noStyles = readParagraphProps(doc('<w:pStyle w:val="H"/>', 'x'))[0];
  eq(noStyles.size, undefined, 'without a styles part nothing is inherited');
  eq(noStyles.styleId, 'H', 'but the style id is still reported');
}

/* ------------------------------------------------- explicit page breaks */

{
  const body = (inner) => `<w:document><w:body>${inner}</w:body></w:document>`;
  const para = (pPr, runs) => `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
  const text = (t) => `<w:r><w:t>${t}</w:t></w:r>`;
  const brPage = '<w:r><w:br w:type="page"/></w:r>';

  const explicit = readParagraphProps(
    body(para('', text('one')) + para('<w:pageBreakBefore/>', text('two'))),
  );
  eq(explicit[0].pageBreakBefore, undefined, 'the first paragraph has no break');
  eq(explicit[1].pageBreakBefore, true, 'w:pageBreakBefore starts a page');

  const disabled = readParagraphProps(
    body(para('<w:pageBreakBefore w:val="0"/>', text('two'))),
  );
  eq(disabled[0].pageBreakBefore, undefined, 'w:val="0" turns the break off');

  // The common shape: a break alone in its own paragraph. mammoth drops that
  // paragraph, so the flag has to carry to the next one with text.
  const carried = readParagraphProps(
    body(para('', text('before')) + para('', brPage) + para('', text('after'))),
  );
  eq(carried.length, 3, 'all three source paragraphs are seen');
  eq(carried[0].pageBreakBefore, undefined, 'the paragraph before the break is untouched');
  eq(carried[2].pageBreakBefore, true, 'the paragraph after an empty break paragraph starts a page');

  const leading = readParagraphProps(body(para('', brPage + text('same para'))));
  eq(leading[0].pageBreakBefore, true, 'a break before any text breaks that paragraph');

  const trailing = readParagraphProps(body(para('', text('words') + brPage)));
  eq(trailing[0].pageBreakBefore, undefined, 'a break after text is not reproduced, and is not misapplied');
}

{
  const measure = (t, st) => t.length * st.size * 0.5;
  const p = (text) => ({ kind: 'paragraph', runs: [{ text }] });

  const plain = layout([p('one'), p('two')], { geometry: A4, scale: DEFAULT_SCALE, measure });
  eq(plain.length, 1, 'two short paragraphs share a page');

  const broken = layout([p('one'), p('two')], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
    appearance: (b) => (b.runs[0].text === 'two' ? { pageBreakBefore: true } : {}),
  });
  eq(broken.length, 2, 'a page break puts the second paragraph on its own page');
  eq(broken[0].items.length, 1, 'the first page keeps only the first paragraph');

  const leadingBreak = layout([p('one')], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
    appearance: () => ({ pageBreakBefore: true }),
  });
  eq(leadingBreak.length, 1, 'a break on the very first block does not emit a blank leading page');
}

/* --------------------------------------------- vertically merged cells */

{
  const cell = (text, extra = {}) => ({ runs: [{ text }], span: 1, ...extra });
  const measure = (t, st) => t.length * st.size * 0.5;

  const table = {
    kind: 'table',
    rows: [
      [cell('spans two', { rowSpan: 2 }), cell('r1c2')],
      // mammoth omits the continuation cell, so this row has ONE td which
      // actually belongs in column 2.
      [cell('r2c2')],
      [cell('r3c1'), cell('r3c2')],
    ],
  };

  const pages = layout([table], { geometry: A4, scale: DEFAULT_SCALE, measure });
  const boxes = pages[0].items.filter((i) => i.kind === 'cellBox');
  const lines = pages[0].items.filter((i) => i.kind === 'line');
  eq(boxes.length, 5, 'five cells were drawn (the continuation is not a cell)');

  const textAt = (needle) => lines.find((l) => l.line.pieces.some((pc) => pc.text.includes(needle)));
  const boxNear = (x) => boxes.filter((b) => Math.abs(b.x - x) < 1);

  const spanning = textAt('spans');
  const r2c2 = textAt('r2c2');
  const r3c1 = textAt('r3c1');
  const r3c2 = textAt('r3c2');
  ok(spanning && r2c2 && r3c1 && r3c2, 'every cell kept its text');

  // The occupancy grid is the whole point: r2c2 must sit in column 2, lined up
  // with r3c2, not back at column 1 underneath the spanning cell.
  ok(Math.abs(r2c2.x - r3c2.x) < 0.5, `r2c2 is in column 2, aligned with r3c2 (${r2c2.x.toFixed(1)} vs ${r3c2.x.toFixed(1)})`);
  ok(r2c2.x > r3c1.x + 10, 'and is well to the right of column 1');
  ok(Math.abs(spanning.x - r3c1.x) < 0.5, 'the spanning cell is in column 1');

  // Its box covers both rows, so it is taller than a single-row box.
  const spanBox = boxNear(A4.margin).sort((a, b) => b.height - a.height)[0];
  const singleBox = boxNear(A4.margin).sort((a, b) => a.height - b.height)[0];
  ok(spanBox.height > singleBox.height * 1.7, `the merged box spans two rows (${spanBox.height.toFixed(1)} vs ${singleBox.height.toFixed(1)})`);

  // Without a rowspan the same table lays out as three ordinary rows.
  const flat = layout(
    [{ kind: 'table', rows: [[cell('a'), cell('b')], [cell('c'), cell('d')]] }],
    { geometry: A4, scale: DEFAULT_SCALE, measure },
  );
  eq(flat[0].items.filter((i) => i.kind === 'cellBox').length, 4, 'a plain 2x2 table still draws four cells');
}

{
  // A rowspan reaching past the last row must be clamped, not run away.
  const measure = (t, st) => t.length * st.size * 0.5;
  const wild = layout(
    [{ kind: 'table', rows: [[{ runs: [{ text: 'x' }], span: 1, rowSpan: 99 }]] }],
    { geometry: A4, scale: DEFAULT_SCALE, measure },
  );
  ok(wild.length >= 1, 'a rowspan larger than the table still lays out');
  const box = wild[0].items.find((i) => i.kind === 'cellBox');
  ok(box.height < A4.height, 'and its box stays within the page');
}


/* --------------------------------------------- run-level colour and size */

// mammoth strips colour AND merges adjacent runs, so a red run followed by a
// highlighted one arrives as one run with no boundary. These offsets put the
// boundaries back, and every assertion here guards against the failure that
// matters most: colour landing on the wrong characters.

{
  const run = (rPr, text) => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`;
  const para = (inner) => `<w:p>${inner}</w:p>`;

  const plain = readRunSpans(para(run('', 'hello')));
  eq(plain.text, 'hello', 'the raw text is recovered');
  eq(plain.spans.length, 0, 'a run with no formatting contributes no span');

  const coloured = readRunSpans(
    para(run('<w:color w:val="1B2A49"/>', 'navy') + run('', 'plain')),
  );
  eq(coloured.text, 'navyplain', 'text from both runs concatenates');
  eq(coloured.spans.length, 1, 'only the coloured run is recorded');
  eq(coloured.spans[0]?.start, 0, 'the span starts at 0');
  eq(coloured.spans[0]?.end, 4, 'and ends where the run does');
  eq(coloured.spans[0]?.color, '1B2A49', 'the colour is upper-cased hex');

  const offset = readRunSpans(para(run('', 'abc') + run('<w:color w:val="ff0000"/>', 'red')));
  eq(offset.spans[0]?.start, 3, 'a later run gets the right start offset');
  eq(offset.spans[0]?.end, 6, 'and the right end');
  eq(offset.spans[0]?.color, 'FF0000', 'lower-case hex is normalised');

  eq(readRunSpans(para(run('<w:color w:val="auto"/>', 'x'))).spans.length, 0, 'w:color auto is not a colour');
  eq(readRunSpans(para(run('<w:color w:val="zzz"/>', 'x'))).spans.length, 0, 'a malformed colour is ignored');

  const hi = readRunSpans(para(run('<w:highlight w:val="yellow"/>', 'marked')));
  eq(hi.spans[0]?.highlight, 'FFFF00', 'a named highlight maps to hex');
  eq(readRunSpans(para(run('<w:highlight w:val="none"/>', 'x'))).spans.length, 0, 'highlight "none" is not a highlight');

  const shd = readRunSpans(para(run('<w:shd w:fill="00FF00"/>', 'shaded')));
  eq(shd.spans[0]?.highlight, '00FF00', 'w:shd fill also reads as a background');

  const sized = readRunSpans(para(run('<w:sz w:val="40"/>', 'big')));
  eq(sized.spans[0]?.size, 20, 'w:sz 40 half-points is 20pt');
  eq(readRunSpans(para(run('<w:sz w:val="2"/>', 'x'))).spans.length, 0, 'an absurd size is ignored');

  // <w:pPr> holds the paragraph mark's own rPr and the tab definitions. Counting
  // either would shift every offset in the paragraph.
  const withPPr = readRunSpans(
    '<w:p><w:pPr><w:rPr><w:color w:val="FF0000"/></w:rPr><w:tabs><w:tab w:pos="100"/></w:tabs></w:pPr>' +
      run('<w:color w:val="0000FF"/>', 'body') + '</w:p>',
  );
  eq(withPPr.text, 'body', 'pPr contributes no text');
  eq(withPPr.spans.length, 1, 'and no span');
  eq(withPPr.spans[0]?.color, '0000FF', 'the body run keeps its own colour');
  eq(withPPr.spans[0]?.start, 0, 'starting at offset 0');

  // Tabs and breaks are one character each, as paragraphText also treats them.
  const tabbed = readRunSpans(para('<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r>'));
  eq(tabbed.text, 'a\tb', 'a tab becomes one character');
}

{
  deep(hexToUnitRgb('FF0000'), { r: 1, g: 0, b: 0 }, 'red converts');
  deep(hexToUnitRgb('000000'), { r: 0, g: 0, b: 0 }, 'black converts');
  const grey = hexToUnitRgb('808080');
  ok(Math.abs(grey.r - 0.502) < 0.01, 'mid grey converts');
  eq(hexToUnitRgb('nope'), null, 'a bad hex string yields null');
}

{
  // tidyRuns collapses whitespace that the XML spells out in full, so offsets
  // are aligned on non-space characters only.
  const map = alignOffsets('a b', 'a    b');
  ok(map !== null, 'collapsed whitespace still aligns');
  eq(map[0], 0, 'the first character maps to offset 0');
  eq(map[2], 5, 'the last maps past the collapsed spaces');

  ok(alignOffsets('', '') !== null, 'two empty strings align');
  ok(alignOffsets('abc', 'abc') !== null, 'identical strings align');
  ok(alignOffsets('a\tb', 'a\tb') !== null, 'tabs align');

  // The safety property: anything that is not the same text must refuse.
  eq(alignOffsets('abc', 'abd'), null, 'different characters refuse to align');
  eq(alignOffsets('ab', 'abc'), null, 'extra text in the XML refuses');
  eq(alignOffsets('abc', 'ab'), null, 'extra text in the block refuses');
}

{
  const spans = [{ start: 0, end: 3, color: 'FF0000' }, { start: 3, end: 6, highlight: 'FFFF00' }];

  const split = applyRunSpans([{ text: 'abcdef' }], 'abcdef', spans);
  ok(split !== null, 'a matching paragraph is split');
  eq(split.length, 2, 'one merged run became two');
  eq(split[0]?.text, 'abc', 'the first piece is the coloured stretch');
  eq(split[0]?.color, 'FF0000', 'and carries the colour');
  eq(split[1]?.text, 'def', 'the second is the highlighted stretch');
  eq(split[1]?.highlight, 'FFFF00', 'and carries the highlight');
  eq(split[0]?.highlight, undefined, 'colour and highlight do not bleed across');

  // Other formatting on the original run must survive the split.
  const styled = applyRunSpans([{ text: 'abcdef', bold: true, href: 'x' }], 'abcdef', spans);
  ok(styled.every((r) => r.bold === true && r.href === 'x'), 'bold and href survive the split');

  // A stretch with no span at all keeps no colour.
  const partial = applyRunSpans([{ text: 'abcdef' }], 'abcdef', [{ start: 2, end: 4, color: '00FF00' }]);
  eq(partial.length, 3, 'an interior span yields three pieces');
  deep(partial.map((r) => r.text), ['ab', 'cd', 'ef'], 'split at the span boundaries');
  eq(partial[1]?.color, '00FF00', 'the middle piece is coloured');
  eq(partial[0]?.color, undefined, 'the outer pieces are not');

  // Splitting must respect existing run boundaries too.
  const across = applyRunSpans([{ text: 'abc' }, { text: 'def' }], 'abcdef', spans);
  eq(across.length, 2, 'two runs matching two spans stay two runs');

  // Refusal, not guesswork.
  eq(applyRunSpans([{ text: 'zzz' }], 'abcdef', spans), null, 'mismatched text refuses to colour anything');
  eq(applyRunSpans([{ text: 'abc' }], 'abc', []), null, 'no spans means nothing to do');
}

{
  // A run declaring its own size drives the piece size and the line height, so
  // a big run cannot overlap the line above it.
  const measure = (text, style) => text.length * style.size * 0.5;

  const mixed = wrapRuns([{ text: 'small ' }, { text: 'BIG', size: 30 }], 11, 500, measure);
  const pieces = mixed.flatMap((l) => l.pieces);
  const big = pieces.find((piece) => piece.text === 'BIG');
  const small = pieces.find((piece) => piece.text === 'small');
  eq(big?.size, 30, 'the run size reaches the piece');
  eq(small?.size, 11, 'the other piece keeps the paragraph size');
  eq(mixed[0]?.height, 30, 'the line is as tall as its tallest piece');

  const uniform = wrapRuns([{ text: 'all the same' }], 11, 500, measure);
  eq(uniform[0]?.height, 11, 'a line with no oversized run is just the paragraph size');

  // Colour and highlight reach the pieces.
  const painted = wrapRuns([{ text: 'red', color: 'FF0000', highlight: 'FFFF00' }], 11, 500, measure);
  const p0 = painted[0].pieces[0];
  eq(p0?.color, 'FF0000', 'the piece carries the colour');
  eq(p0?.highlight, 'FFFF00', 'and the highlight');

  // A larger run must push the following lines further down the page.
  const tallDoc = layout(
    [{ kind: 'paragraph', runs: [{ text: 'HUGE', size: 40 }] }, { kind: 'paragraph', runs: [{ text: 'after' }] }],
    { geometry: A4, scale: DEFAULT_SCALE, measure },
  );
  const flatDoc = layout(
    [{ kind: 'paragraph', runs: [{ text: 'HUGE' }] }, { kind: 'paragraph', runs: [{ text: 'after' }] }],
    { geometry: A4, scale: DEFAULT_SCALE, measure },
  );
  const yOf = (pages) => pages[0].items.filter((i) => i.kind === 'line').map((i) => i.y);
  ok(
    yOf(tallDoc)[1] < yOf(flatDoc)[1] - 10,
    `a 40pt run pushes the next line down (${yOf(tallDoc)[1].toFixed(1)} vs ${yOf(flatDoc)[1].toFixed(1)})`,
  );
}


/* ------------------------------------------------- table cell run properties */

// readParagraphProps strips tables, so cell text got no colour, highlight or
// per-run size. Cells are matched structurally instead - by where they sit, not
// by what they say, so two cells reading "Yes" cannot be confused.

{
  const cell = (inner, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${inner}</w:tc>`;
  const para = (rPr, text) => `<w:p><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r></w:p>`;
  const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
  const tbl = (...rows) => `<w:tbl>${rows.join('')}</w:tbl>`;

  eq(readTableCellRuns('<w:body/>').length, 0, 'a document with no tables yields nothing');

  const simple = readTableCellRuns(
    tbl(
      row(cell(para('<w:color w:val="1B2A49"/>', 'Label')), cell(para('', 'Value'))),
      row(cell(para('', 'a')), cell(para('<w:highlight w:val="yellow"/>', 'b'))),
    ),
  );
  eq(simple.length, 1, 'one table');
  eq(simple[0].length, 2, 'two rows');
  eq(simple[0][0].length, 2, 'two cells in row 1');
  eq(simple[0][0][0].text, 'Label', 'cell text is recovered');
  eq(simple[0][0][0].spans[0]?.color, '1B2A49', 'and its colour');
  eq(simple[0][0][1].spans.length, 0, 'an unstyled cell has no spans');
  eq(simple[0][1][1].spans[0]?.highlight, 'FFFF00', 'a highlight in row 2 is found');

  // A cell holding several paragraphs concatenates with no separator, exactly
  // as blocks.ts flattens it - so the second paragraph's offsets must shift.
  const multi = readTableCellRuns(
    tbl(row(cell(para('', 'first') + para('<w:color w:val="FF0000"/>', 'second')))),
  );
  eq(multi[0][0][0].text, 'firstsecond', 'both paragraphs concatenate');
  eq(multi[0][0][0].spans.length, 1, 'one span');
  eq(multi[0][0][0].spans[0]?.start, 5, 'shifted past the first paragraph');
  eq(multi[0][0][0].spans[0]?.end, 11, 'and ends at the cell text length');

  // mammoth omits vMerge continuation cells, so keeping them would make every
  // row after a merge one cell too long and the whole table would be skipped.
  const merged = readTableCellRuns(
    tbl(
      row(cell(para('', 'spans'), '<w:vMerge w:val="restart"/>'), cell(para('', 'r1c2'))),
      row(cell('<w:p/>', '<w:vMerge/>'), cell(para('<w:color w:val="00FF00"/>', 'r2c2'))),
    ),
  );
  eq(merged[0][0].length, 2, 'the restart row keeps both cells');
  eq(merged[0][1].length, 1, 'the continuation cell is skipped, matching mammoth');
  eq(merged[0][1][0].text, 'r2c2', 'so the remaining cell is the second column');
  eq(merged[0][1][0].spans[0]?.color, '00FF00', 'and keeps its colour');

  const two = readTableCellRuns(tbl(row(cell(para('', 'x')))) + tbl(row(cell(para('', 'y')))));
  eq(two.length, 2, 'two sibling tables are both read');
  eq(two[1][0][0].text, 'y', 'in document order');
}

{
  // A cell run declaring a larger size must grow its row rather than overflow.
  const measure = (text, style) => text.length * style.size * 0.5;
  const table = (size) => ({
    kind: 'table',
    rows: [[{ runs: [{ text: 'tall', ...(size ? { size } : {}) }], span: 1 }]],
  });

  const boxOf = (block) => {
    const pages = layout([block], { geometry: A4, scale: DEFAULT_SCALE, measure });
    return pages[0].items.find((i) => i.kind === 'cellBox');
  };

  const plain = boxOf(table(null));
  const big = boxOf(table(40));
  ok(
    big.height > plain.height * 2,
    `a 40pt run grows its row (${big.height.toFixed(1)} vs ${plain.height.toFixed(1)})`,
  );

  // The text must stay inside the box it grew.
  const pages = layout([table(40)], { geometry: A4, scale: DEFAULT_SCALE, measure });
  const box = pages[0].items.find((i) => i.kind === 'cellBox');
  const line = pages[0].items.find((i) => i.kind === 'line');
  ok(line.y >= box.y, `the baseline sits inside the cell box (${line.y.toFixed(1)} >= ${box.y.toFixed(1)})`);
  ok(line.y <= box.y + box.height, 'and below its top edge');
}


/* ------------------------------------------------------------------ columns */

{
  const sect = (cols) =>
    '<w:document><w:body><w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/>' +
    (cols ?? '') +
    '</w:sectPr></w:body></w:document>';

  const plain = readPageSetup(sect(null));
  eq(plain.columns, 1, 'a section with no w:cols is one column');
  eq(plain.columnGap, 0, 'and no gutter');

  const two = readPageSetup(sect('<w:cols w:num="2" w:space="425"/>'));
  eq(two.columns, 2, 'w:num=2 is two columns');
  ok(Math.abs(two.columnGap - 21.25) < 0.01, '425tw gutter is 21.25pt');

  const noSpace = readPageSetup(sect('<w:cols w:num="3"/>'));
  eq(noSpace.columns, 3, 'three columns');
  ok(noSpace.columnGap > 0, 'a multi-column section without w:space still gets a gutter');

  const wild = readPageSetup(sect('<w:cols w:num="99"/>'));
  eq(wild.columns, 8, 'a runaway w:num is capped rather than slicing the page up');

  const junk = readPageSetup(sect('<w:cols w:num="abc"/>'));
  eq(junk.columns, 1, 'an unparseable w:num falls back to one column');
}

{
  const measure = (text, style) => text.length * style.size * 0.5;
  // Enough text to overflow one column but not two.
  const many = Array.from({ length: 22 }, (_, i) => ({
    kind: 'paragraph',
    runs: [{ text: `Paragraph ${i + 1} with enough words in it to occupy several lines of a narrow column.` }],
  }));

  const single = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure });
  const twoCol = layout(many, {
    geometry: A4, scale: DEFAULT_SCALE, measure, columns: 2, columnGap: 20,
  });

  const xsOf = (page) => [...new Set(page.items.filter((i) => i.kind === 'line').map((i) => Math.round(i.x)))];

  eq(xsOf(single[0]).length, 1, 'a single-column page uses one left edge');
  eq(xsOf(single[0])[0], A4.margin, 'which is the page margin');

  const xs = xsOf(twoCol[0]).sort((a, b) => a - b);
  eq(xs.length, 2, `a two-column page uses two left edges (got ${xs.join(', ')})`);
  eq(xs[0], A4.margin, 'the first column starts at the margin');

  const colWidth = (A4.width - A4.margin * 2 - 20) / 2;
  ok(
    Math.abs(xs[1] - (A4.margin + colWidth + 20)) < 1,
    `the second column clears the first plus the gutter (${xs[1]} vs ${(A4.margin + colWidth + 20).toFixed(0)})`,
  );

  // Columns must FILL before a page is started - that is the behaviour, and
  // it is not a page saving: a narrow column wraps roughly twice as often, so
  // the two arrangements come out about even on area.
  eq(xsOf(twoCol[0]).length, 2, 'page 1 is filled in both columns before a page is started');
  ok(
    twoCol.length <= single.length,
    `two columns are no worse on page count (${twoCol.length} vs ${single.length})`,
  );

  // Lines must stay inside their own column.
  for (const page of twoCol) {
    for (const item of page.items) {
      if (item.kind !== 'line') continue;
      const right = item.x + Math.max(...item.line.pieces.map((pc) => pc.x + pc.width), 0);
      ok(right <= A4.width - A4.margin + 1, 'no line spills past the right margin');
      const inFirst = Math.abs(item.x - A4.margin) < 1;
      const limit = inFirst ? A4.margin + colWidth + 1 : A4.width - A4.margin + 1;
      ok(right <= limit, 'and no line crosses into the neighbouring column');
    }
  }
}

{
  // Text is measured at the column width, so a two-column run wraps more often.
  const measure = (text, style) => text.length * style.size * 0.5;
  const one = [{ kind: 'paragraph', runs: [{ text: 'word '.repeat(60).trim() }] }];

  const wide = layout(one, { geometry: A4, scale: DEFAULT_SCALE, measure });
  const narrow = layout(one, { geometry: A4, scale: DEFAULT_SCALE, measure, columns: 2, columnGap: 20 });
  const lineCount = (pages) => pages.reduce((n, pg) => n + pg.items.filter((i) => i.kind === 'line').length, 0);
  ok(
    lineCount(narrow) > lineCount(wide),
    `the same paragraph wraps more in a column (${lineCount(narrow)} vs ${lineCount(wide)} lines)`,
  );
}

{
  // A single column must behave exactly as it did before columns existed.
  const measure = (text, style) => text.length * style.size * 0.5;
  const blocks = [
    { kind: 'heading', level: 2, runs: [{ text: 'Head' }] },
    { kind: 'paragraph', runs: [{ text: 'Body text that wraps a little.' }] },
    { kind: 'table', rows: [[{ runs: [{ text: 'a' }], span: 1 }, { runs: [{ text: 'b' }], span: 1 }]] },
    { kind: 'image', dataUri: 'data:,', width: 100, height: 50 },
  ];
  const before = layout(blocks, { geometry: A4, scale: DEFAULT_SCALE, measure });
  const explicit = layout(blocks, { geometry: A4, scale: DEFAULT_SCALE, measure, columns: 1, columnGap: 0 });
  eq(
    JSON.stringify(explicit),
    JSON.stringify(before),
    'columns:1 is byte-for-byte identical to omitting the option',
  );
}


/* ------------------------------------------- headers, footers, page numbers */

// These live in their own parts, reached through a relationship id. mammoth
// converts only document.xml, so headers vanished entirely.

{
  const rels =
    '<Relationships>' +
    '<Relationship Id="rId4" Type="x/header" Target="header1.xml"/>' +
    '<Relationship Id="rId5" Type="x/footer" Target="./footer2.xml"/>' +
    '<Relationship Id="rId6" Type="x/header" Target="/word/header3.xml"/>' +
    '<Relationship Id="bad" Type="x/other"/>' +
    '</Relationships>';
  const map = readRelationships(rels);
  eq(map.get('rId4'), 'word/header1.xml', 'a plain target is resolved under word/');
  eq(map.get('rId5'), 'word/footer2.xml', 'a leading ./ is stripped');
  eq(map.get('rId6'), 'word/header3.xml', 'an absolute /word/ target is normalised');
  eq(map.has('bad'), false, 'a relationship with no target is skipped');
  eq(readRelationships('<Relationships/>').size, 0, 'an empty rels part yields nothing');
}

{
  const rels =
    '<Relationships>' +
    '<Relationship Id="h1" Target="header1.xml"/>' +
    '<Relationship Id="h2" Target="header2.xml"/>' +
    '<Relationship Id="f1" Target="footer1.xml"/>' +
    '</Relationships>';
  const doc = (sect) => `<w:document><w:body><w:sectPr>${sect}</w:sectPr></w:body></w:document>`;

  const full = readFurnitureRefs(
    doc(
      '<w:headerReference r:id="h1" w:type="default"/>' +
        '<w:headerReference r:id="h2" w:type="first"/>' +
        '<w:footerReference r:id="f1" w:type="default"/>' +
        '<w:titlePg/><w:pgMar w:header="720" w:footer="576"/>',
    ),
    rels,
  );
  eq(full.header, 'word/header1.xml', 'the default header is resolved');
  eq(full.headerFirst, 'word/header2.xml', 'and the first-page header');
  eq(full.footer, 'word/footer1.xml', 'and the footer');
  eq(full.footerFirst, undefined, 'a first-page footer that was not declared stays absent');
  eq(full.titlePg, true, 'w:titlePg is honoured');
  ok(Math.abs(full.headerDistance - 36) < 0.01, '720tw header distance is 36pt');
  ok(Math.abs(full.footerDistance - 28.8) < 0.01, '576tw footer distance is 28.8pt');

  const bare = readFurnitureRefs(doc('<w:pgMar w:top="1134"/>'), rels);
  eq(bare.header, undefined, 'a section with no reference has no header');
  eq(bare.titlePg, false, 'and no title page');
  ok(bare.headerDistance > 0, 'the distances still get a sane default');

  const off = readFurnitureRefs(doc('<w:titlePg w:val="0"/>'), rels);
  eq(off.titlePg, false, 'w:titlePg val=0 turns it off');

  // "even" only applies with evenAndOddHeaders; using it blindly would put it
  // on every other page.
  const even = readFurnitureRefs(doc('<w:headerReference r:id="h1" w:type="even"/>'), rels);
  eq(even.header, undefined, 'an even-page header is ignored rather than misapplied');
}

{
  // Both field spellings, and the cached value must be dropped: it is whatever
  // the number happened to be when Word last saved.
  const simple = substituteFields('<w:fldSimple w:instr=" PAGE "><w:r><w:t>99</w:t></w:r></w:fldSimple>', 3, 12);
  ok(simple.includes('>3<'), 'fldSimple PAGE becomes the real page number');
  ok(!simple.includes('99'), 'and the cached 99 is gone');

  const total = substituteFields('<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>77</w:t></w:r></w:fldSimple>', 3, 12);
  ok(total.includes('>12<'), 'NUMPAGES becomes the page count');
  ok(!total.includes('77'), 'and its cached value is gone');

  const selfClosing = substituteFields('<w:fldSimple w:instr=" PAGE "/>', 5, 9);
  ok(selfClosing.includes('>5<'), 'a self-closing fldSimple works too');

  const chars = substituteFields(
    '<w:r><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText>' +
      '<w:fldChar w:fldCharType="separate"/><w:t>42</w:t><w:fldChar w:fldCharType="end"/></w:r>',
    7,
    9,
  );
  ok(chars.includes('>7<'), 'the begin/instrText/end run form works');
  ok(!chars.includes('42'), 'and drops the cached value');

  // Anything that is not a page field must be left exactly as it was.
  const other = '<w:fldSimple w:instr=" TOC \\o &quot;1-3&quot; "><w:r><w:t>Contents</w:t></w:r></w:fldSimple>';
  eq(substituteFields(other, 1, 1), other, 'a TOC field is left untouched');
  eq(substituteFields('<w:p><w:r><w:t>plain</w:t></w:r></w:p>', 1, 1), '<w:p><w:r><w:t>plain</w:t></w:r></w:p>', 'text with no fields is unchanged');
}

{
  const hdr =
    '<w:hdr><w:p>' +
    '<w:pPr><w:jc w:val="center"/><w:tabs><w:tab w:val="right" w:pos="9000"/><w:tab w:val="center" w:pos="4500"/></w:tabs></w:pPr>' +
    '<w:r><w:rPr><w:b/><w:i/><w:color w:val="1b2a49"/><w:sz w:val="18"/></w:rPr><w:t>Name</w:t></w:r>' +
    '<w:r><w:tab/></w:r>' +
    '<w:r><w:t xml:space="preserve">Page </w:t></w:r>' +
    '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
    '</w:p><w:p/><w:p><w:r><w:t>second line</w:t></w:r></w:p></w:hdr>';

  const parts = parseFurniture(hdr, 4, 10);
  eq(parts.length, 2, 'an empty paragraph is skipped');

  const first = parts[0];
  eq(first.align, 'center', 'alignment is read');
  eq(first.tabs.length, 2, 'both tab stops are read');
  ok(first.tabs[0].pos < first.tabs[1].pos, 'and sorted by position');
  eq(first.tabs[0].align, 'center', 'the nearer stop is the centre one');

  const runs = first.block.runs;
  eq(runs.map((r) => r.text).join(''), 'Name\tPage 4', 'the page number is substituted inline');
  eq(runs[0].bold, true, 'bold is read');
  eq(runs[0].italic, true, 'italic is read');
  eq(runs[0].color, '1B2A49', 'colour is read and upper-cased');
  eq(runs[0].size, 9, 'size is read in points');
  eq(parts[1].block.runs[0].text, 'second line', 'a second paragraph is kept');

  eq(parseFurniture('<w:hdr/>', 1, 1).length, 0, 'an empty header yields no blocks');
}

{
  // The insets are what stop the body printing over the bands.
  const measure = (text, style) => text.length * style.size * 0.5;
  const many = Array.from({ length: 40 }, (_, i) => ({
    kind: 'paragraph',
    runs: [{ text: `Paragraph ${i + 1} with a reasonable number of words in it.` }],
  }));

  const plain = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure });
  const inset = layout(many, {
    geometry: A4, scale: DEFAULT_SCALE, measure, insetTop: 60, insetBottom: 60,
  });

  const topOf = (pages) => Math.max(...pages[0].items.filter((i) => i.kind === 'line').map((i) => i.y));
  const bottomOf = (pages) => Math.min(...pages[0].items.filter((i) => i.kind === 'line').map((i) => i.y));

  ok(topOf(inset) < topOf(plain) - 50, `insetTop pushes the first line down (${topOf(inset).toFixed(0)} vs ${topOf(plain).toFixed(0)})`);
  ok(bottomOf(inset) > bottomOf(plain), 'insetBottom lifts the last line off the page bottom');
  // More direct than page count, which only changes once the content crosses
  // a boundary: a shorter text area holds fewer lines per page.
  const linesOnFirst = (pages) => pages[0].items.filter((i) => i.kind === 'line').length;
  ok(
    linesOnFirst(inset) < linesOnFirst(plain),
    `fewer lines fit on a page with the bands reserved (${linesOnFirst(inset)} vs ${linesOnFirst(plain)})`,
  );
  ok(inset.length >= plain.length, 'and never fewer pages than without them');

  const zero = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure, insetTop: 0, insetBottom: 0 });
  eq(JSON.stringify(zero), JSON.stringify(plain), 'zero insets are identical to omitting them');
}


/* ---------------------------------------------------- even and odd headers */

{
  const rels =
    '<Relationships>' +
    '<Relationship Id="hd" Target="header1.xml"/>' +
    '<Relationship Id="he" Target="header2.xml"/>' +
    '</Relationships>';
  const doc =
    '<w:document><w:body><w:sectPr>' +
    '<w:headerReference r:id="hd" w:type="default"/>' +
    '<w:headerReference r:id="he" w:type="even"/>' +
    '</w:sectPr></w:body></w:document>';

  // Without the document setting the even reference is inert. Honouring it
  // anyway would put the even header on every other page of a document that
  // never asked for one.
  const off = readFurnitureRefs(doc, rels);
  eq(off.evenAndOdd, false, 'no settings part means no even/odd');
  eq(off.headerEven, undefined, 'so the even reference is dropped');
  eq(off.header, 'word/header1.xml', 'while the default survives');

  const on = readFurnitureRefs(doc, rels, '<w:settings><w:evenAndOddHeaders/></w:settings>');
  eq(on.evenAndOdd, true, 'the setting is read');
  eq(on.headerEven, 'word/header2.xml', 'and the even reference is kept');

  const disabled = readFurnitureRefs(doc, rels, '<w:settings><w:evenAndOddHeaders w:val="0"/></w:settings>');
  eq(disabled.evenAndOdd, false, 'w:val="0" turns the setting off');
  eq(disabled.headerEven, undefined, 'and drops the reference again');
}

/* ------------------------------------------------------------- text boxes */

{
  const box = (inner) =>
    '<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><wp:anchor>' +
    `<wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx>` +
    '</wp:anchor></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict><v:textbox><w:txbxContent>' + inner +
    '</w:txbxContent></v:textbox></w:pict></mc:Fallback>' +
    '</mc:AlternateContent></w:r></w:p>';

  const doc =
    '<w:body><w:p><w:r><w:t>Before the box</w:t></w:r></w:p>' +
    box('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>BOXED</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second boxed line</w:t></w:r></w:p>') +
    '<w:p><w:r><w:t>After the box</w:t></w:r></w:p></w:body>';

  const boxes = readTextBoxes(doc);
  // The Fallback branch repeats the same content, so counting it would double
  // every text box in the document.
  eq(boxes.length, 1, 'an mc:AlternateContent text box is found once, not twice');
  eq(boxes[0].blocks.length, 2, 'both of its paragraphs are read');
  eq(boxes[0].blocks[0].align, 'center', 'alignment inside the box is kept');
  eq(boxes[0].blocks[0].block.runs[0].bold, true, 'and run formatting');
  eq(boxes[0].afterText, 'Before the box', 'the anchor text is the paragraph before it');
  eq(
    boxes[0].blocks.map((b) => b.block.runs.map((r) => r.text).join('')).join('|'),
    'BOXED|Second boxed line',
    'the content is complete and in order',
  );

  eq(readTextBoxes('<w:body><w:p><w:r><w:t>none here</w:t></w:r></w:p></w:body>').length, 0,
    'a document with no text box yields nothing');
  eq(readTextBoxes('<w:body>' + box('<w:p/>') + '</w:body>').length, 0,
    'an empty text box contributes no blocks');

  eq(parseParagraphBlocks('<w:p><w:r><w:t>plain</w:t></w:r></w:p>').length, 1,
    'parseParagraphBlocks reads a bare fragment');
}

/* ------------------------------------- a list item whose content is in a <p> */

{
  // mammoth wraps footnote text as <ol><li><p>…</p></li></ol>. The <p> used to
  // flush the pending listItem and replace it with a plain paragraph, throwing
  // the number away — so notes arrived with no way to tell which was which.
  const blocks = parseBlocks(
    '<ol><li><p>First note</p></li><li><p>Second note</p></li></ol>',
  );
  eq(blocks.length, 2, 'two list items');
  eq(blocks[0].kind, 'listItem', 'a <li> wrapping a <p> is still a list item');
  eq(blocks[0].marker, '1.', 'and keeps its number');
  eq(blocks[1].marker, '2.', 'which increments');
  ok(blocks.every((b) => b.ordered === true), 'both are ordered');

  // The plain shape must still work.
  const bare = parseBlocks('<ul><li>Plain item</li></ul>');
  eq(bare[0].kind, 'listItem', 'a <li> with bare text is unaffected');
  ok(bare[0].marker.length > 0, 'and still has a bullet');

  // A paragraph outside any list is still a paragraph.
  const para = parseBlocks('<p>Ordinary</p>');
  eq(para[0].kind, 'paragraph', 'a top-level <p> is not turned into a list item');
}

/* --------------------------------------------------- bidi visual reordering */

{
  const bidi = bidiFactory();
  const tok = (text) => ({ text });

  // Pure Arabic: wrapRuns tokenises on spaces, so the WORDS came out backwards
  // even though each word was shaped correctly.
  const arabic = ['مرحبا', ' ', 'بالعالم', ' ', 'الهند'].map(tok);
  const { order, baseRtl } = reorderTokens(bidi, arabic, 'rtl');
  eq(baseRtl, true, 'an RTL base direction is reported');
  deep(order, [4, 3, 2, 1, 0], 'the tokens are reversed for display');

  // Latin is untouched.
  const latin = ['Hello', ' ', 'world'].map(tok);
  deep(reorderTokens(bidi, latin, 'ltr').order, [0, 1, 2], 'left-to-right text keeps its order');
  eq(reorderTokens(bidi, latin, 'ltr').baseRtl, false, 'and reports an LTR base');

  {
    // Mixed: the embedded English must stay in reading order inside the
    // reversed Arabic, which is what rule L2 is for.
    const mixed = ['مرحبا', ' ', 'Nikhil', ' ', 'بالعالم'].map(tok);
    const result = reorderTokens(bidi, mixed, 'rtl');
    eq(result.order[0], 4, 'the last Arabic word is drawn leftmost');
    eq(result.order[result.order.length - 1], 0, 'and the first Arabic word rightmost');
    eq(result.order.indexOf(2), 2, 'the English word sits between them');
  }

  {
    // Two English words inside Arabic must not themselves be reversed.
    const phrase = ['بالعالم', ' ', 'Nikhil', ' ', 'Khilwani', ' ', 'مرحبا'].map(tok);
    const result = reorderTokens(bidi, phrase, 'rtl');
    const nikhil = result.order.indexOf(2);
    const khilwani = result.order.indexOf(4);
    ok(nikhil < khilwani, `the embedded English reads left to right (${nikhil} < ${khilwani})`);
  }

  eq(reorderTokens(bidi, [], 'auto').order.length, 0, 'no tokens is not an error');
  deep(reorderTokens(bidi, [tok('one')], 'auto').order, [0], 'a single token needs no reordering');
}

{
  // End to end through wrapRuns: without a bidi instance nothing is reordered,
  // which is exactly the behaviour that shipped before.
  const measure = (text, style) => text.length * style.size * 0.5;
  const runs = [{ text: 'مرحبا بالعالم' }];

  const logical = wrapRuns(runs, 11, 400, measure);
  const visual = wrapRuns(runs, 11, 400, measure, [], { bidi: bidiFactory(), rtl: true });

  const textsOf = (lines) => lines[0].pieces.map((p) => p.text);
  deep(textsOf(logical), ['مرحبا', ' ', 'بالعالم'], 'no bidi instance leaves logical order');
  deep(textsOf(visual), ['بالعالم', ' ', 'مرحبا'], 'with one, the words are reversed for display');

  // x must be recomputed, or the reordered pieces would overlap.
  const xs = visual[0].pieces.map((p) => p.x);
  ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'x positions increase across the visual order');
  eq(xs[0], 0, 'and start at the line origin');
}


/* ------------------------------------- table cells: alignment and spacing */

{
  // Cell text was always drawn flush left, whatever the document said.
  const measure = (text, style) => text.length * style.size * 0.5;
  const cellWith = (extra) => ({
    kind: 'table',
    rows: [[{ runs: [{ text: 'hi' }], span: 1, ...extra }]],
  });

  // alignLine shifts piece.x, not the line item's x, so the drawn position is
  // the sum of the two.
  const xOf = (block) => {
    const pages = layout([block], { geometry: A4, scale: DEFAULT_SCALE, measure });
    const item = pages[0].items.find((i) => i.kind === 'line');
    return item.x + item.line.pieces[0].x;
  };

  const left = xOf(cellWith({}));
  const centre = xOf(cellWith({ align: 'center' }));
  const right = xOf(cellWith({ align: 'right' }));
  ok(centre > left + 20, `a centred cell is indented (${centre.toFixed(0)} vs ${left.toFixed(0)})`);
  ok(right > centre + 20, `and a right-aligned one further still (${right.toFixed(0)})`);
  eq(xOf(cellWith({ align: 'left' })), left, 'an explicit left is the same as the default');

  const boxOf = (block) => {
    const pages = layout([block], { geometry: A4, scale: DEFAULT_SCALE, measure });
    return pages[0].items.find((i) => i.kind === 'cellBox');
  };
  const plain = boxOf(cellWith({}));
  const spaced = boxOf(cellWith({ spaceBefore: 20, spaceAfter: 10 }));
  ok(
    spaced.height > plain.height + 25,
    `cell spacing grows the row (${spaced.height.toFixed(1)} vs ${plain.height.toFixed(1)})`,
  );

  // The text must stay inside the row it grew.
  const pages = layout([cellWith({ spaceBefore: 20, spaceAfter: 10 })], {
    geometry: A4, scale: DEFAULT_SCALE, measure,
  });
  const box = pages[0].items.find((i) => i.kind === 'cellBox');
  const line = pages[0].items.find((i) => i.kind === 'line');
  ok(line.y >= box.y && line.y <= box.y + box.height, 'and the baseline stays inside the box');
}


/* -------------------------------------------------------------- footnotes */

{
  eq(markerId('#footnote-2'), '2', 'a marker link yields its id');
  eq(markerId('#footnote-ref-2'), null, 'a back-link is not a marker');
  eq(markerId('https://example.com'), null, 'an external link is not a marker');
  eq(markerId(undefined), null, 'no link is not a marker');

  eq(backReferenceId('#footnote-ref-2'), '2', 'a back-link yields its id');
  eq(backReferenceId('#footnote-2'), null, 'a marker is not a back-link');
}

{
  // mammoth appends the notes as an <ol> whose items link back to the marker.
  // The anchors are the signal, not the position, so a document that merely
  // ends with a list is left alone.
  const blocks = parseBlocks(
    '<p>Claim<sup><a href="#footnote-2" id="footnote-ref-2">[1]</a></sup> and more.</p>' +
      '<p>Second<sup><a href="#footnote-3">[2]</a></sup>.</p>' +
      '<ol><li><p>NOTEONE text. <a href="#footnote-ref-2">^</a></p></li>' +
      '<li><p>NOTETWO text. <a href="#footnote-ref-3">^</a></p></li></ol>',
  );

  const split = splitNotes(blocks);
  eq(split.notes.size, 2, 'both notes are separated out');
  eq(split.body.length, 2, 'and the body keeps only its own paragraphs');
  ok(
    split.notes.get('2').runs.map((r) => r.text).join('').includes('NOTEONE'),
    'note 2 carries its text',
  );
  ok(
    !split.notes.get('2').runs.some((r) => backReferenceId(r.anchor) !== null),
    'the back-link run is dropped — an arrow to an anchor is useless in print',
  );
  eq(split.notes.get('2').marker, '1.', 'the note keeps the number mammoth gave it');

  // Markers are found on the body paragraphs.
  deep(markersIn(split.body[0]), ['2'], 'the first paragraph references note 2');
  deep(markersIn(split.body[1]), ['3'], 'the second references note 3');
  deep(markersIn(split.notes.get('2')), [], 'a note references nothing itself');

  // A plain list must not be mistaken for notes.
  const plain = splitNotes(parseBlocks('<p>Text</p><ol><li><p>Just a list</p></li></ol>'));
  eq(plain.notes.size, 0, 'an ordinary trailing list is not treated as footnotes');
  eq(plain.body.length, 2, 'and stays in the body');
}

{
  // An internal anchor must be recorded WITHOUT becoming a clickable link:
  // nothing in a standalone PDF can follow it, but placement needs to see it.
  const runs = parseBlocks('<p>Claim<a href="#footnote-2">[1]</a></p>')[0].runs;
  const marker = runs.find((r) => r.text === '[1]');
  eq(marker.anchor, '#footnote-2', 'the anchor is kept');
  eq(marker.href, undefined, 'but it is not a followable link');

  const external = parseBlocks('<p><a href="https://example.com">site</a></p>')[0].runs[0];
  eq(external.href, 'https://example.com', 'a real destination is still a link');
  eq(external.anchor, undefined, 'and carries no anchor');
}

{
  // Per-page reserve: layout must be able to keep a different amount of room
  // clear on each page, or every page would reserve room for every note.
  const measure = (text, style) => text.length * style.size * 0.5;
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: 'paragraph',
    runs: [{ text: `Paragraph ${i + 1} with a reasonable number of words in it.` }],
  }));

  const flat = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure, insetBottom: 0 });
  const firstOnly = layout(many, {
    geometry: A4, scale: DEFAULT_SCALE, measure,
    insetBottom: (index) => (index === 0 ? 200 : 0),
  });

  const linesOn = (pages, i) => pages[i].items.filter((it) => it.kind === 'line').length;
  ok(
    linesOn(firstOnly, 0) < linesOn(flat, 0),
    `a reserve on page 1 shortens only page 1 (${linesOn(firstOnly, 0)} vs ${linesOn(flat, 0)})`,
  );
  ok(
    linesOn(firstOnly, 1) >= linesOn(flat, 1) - 1,
    'while page 2 keeps its full height',
  );

  const constant = layout(many, { geometry: A4, scale: DEFAULT_SCALE, measure, insetBottom: 200 });
  ok(
    linesOn(constant, 1) < linesOn(firstOnly, 1),
    'a constant reserve shortens every page, unlike a per-page one',
  );
}

/* ---------------------------------- table cells: indents and tab stops */

{
  const measure = (text, style) => text.length * style.size * 0.5;
  const cell = (extra) => ({
    kind: 'table',
    rows: [[{ runs: [{ text: 'x' }], span: 1, ...extra }]],
  });
  const drawn = (block) => {
    const pages = layout([block], { geometry: A4, scale: DEFAULT_SCALE, measure });
    const item = pages[0].items.find((i) => i.kind === 'line');
    return item.x + item.line.pieces[0].x;
  };

  const plain = drawn(cell({}));
  ok(drawn(cell({ indent: 40 })) > plain + 35, 'a cell indent moves its text right');
  ok(drawn(cell({ firstLine: 30 })) > plain + 25, 'a first-line indent moves the first line right');

  // The indent must also NARROW the cell, not just shift the text: a shifted
  // line with the old width would run out past the cell border.
  const longCell = (extra) => ({
    kind: 'table',
    rows: [[{ runs: [{ text: 'word '.repeat(30).trim() }], span: 1, ...extra }]],
  });
  const linesIn = (block) => {
    const pages = layout([block], { geometry: A4, scale: DEFAULT_SCALE, measure });
    return pages[0].items.filter((i) => i.kind === 'line').length;
  };
  ok(
    linesIn(longCell({ indent: 120 })) > linesIn(longCell({})),
    `an indented cell wraps more (${linesIn(longCell({ indent: 120 }))} vs ${linesIn(longCell({}))})`,
  );

  {
    // A tab stop inside a cell has to position text, not collapse to nothing.
    const tabbedCell = {
      kind: 'table',
      rows: [[{ runs: [{ text: 'a	b' }], span: 1, tabs: [{ pos: 90, align: 'left' }] }]],
    };
    const tabbed = layout([tabbedCell], { geometry: A4, scale: DEFAULT_SCALE, measure });
    const pieces = tabbed[0].items.find((i) => i.kind === 'line').line.pieces;
    const after = pieces.find((piece) => piece.text === 'b');
    ok(after !== undefined, 'the text after the tab survives');
    ok(after.x >= 85, `and starts at the stop (${after.x.toFixed(1)})`);
  }
}


/* ============================================================ text compare */

/* ---- line splitting: the source of phantom trailing lines ---- */

deep(splitLines(''), [], 'empty text is no lines at all');
deep(splitLines('a'), ['a'], 'one line with no terminator');
deep(splitLines('a\n'), ['a'], 'a trailing newline does NOT invent a second line');
deep(splitLines('a\nb'), ['a', 'b'], 'two lines');
deep(splitLines('a\nb\n'), ['a', 'b'], 'two lines with a terminator');
deep(splitLines('a\r\nb'), ['a', 'b'], 'CRLF is normalised');
deep(splitLines('a\rb'), ['a', 'b'], 'a lone CR is normalised too');
deep(splitLines('\n'), [''], 'a single newline is one empty line');
deep(splitLines('a\n\nb'), ['a', '', 'b'], 'a blank line in the middle is kept');

/* ---- the comparison key ---- */

eq(normaliseLine('  Hello   World  ', {}), '  Hello   World  ', 'no options changes nothing');
eq(normaliseLine('  Hello   World  ', { ignoreWhitespace: true }), 'Hello World', 'whitespace collapses and trims');
eq(normaliseLine('Hello', { ignoreCase: true }), 'hello', 'case folds');
eq(
  normaliseLine('  HELLO   world ', { ignoreCase: true, ignoreWhitespace: true }),
  'hello world',
  'both together',
);

/* ---- the invariant: applying a diff to the left reproduces the right ---- */

{
  // This one assertion catches almost any indexing slip in Myers or in the
  // prefix/suffix trimming, which is why it is a property over random input
  // rather than a handful of examples.
  const rnd = (n) => Math.floor(Math.random() * n);
  const word = () => 'abcdefghij'[rnd(10)].repeat(1 + rnd(3));
  const line = () => Array.from({ length: 1 + rnd(5) }, word).join(' ');

  let mismatched = 0;
  let firstFailure = null;

  for (let trial = 0; trial < 1200; trial++) {
    const a = Array.from({ length: rnd(14) }, line);
    const b = [...a];
    for (let edit = 0; edit < rnd(6); edit++) {
      const kind = rnd(3);
      if (kind === 0 && b.length) b.splice(rnd(b.length), 1);
      else if (kind === 1) b.splice(rnd(b.length + 1), 0, line());
      else if (b.length) b[rnd(b.length)] = line();
    }
    const leftText = a.join('\n');
    const rightText = b.join('\n');
    const diff = diffLines(leftText, rightText);
    if (applyEdits(diff).join('\n') !== rightText) {
      mismatched++;
      firstFailure ??= { leftText, rightText, got: applyEdits(diff).join('\n') };
    }
  }
  eq(mismatched, 0, `applying the diff reproduces the right side (1200 derived pairs)${firstFailure ? ` — first failure ${JSON.stringify(firstFailure)}` : ''}`);

  // Unrelated pairs exercise the large-D path rather than the near-identical one.
  let unrelatedBad = 0;
  for (let trial = 0; trial < 600; trial++) {
    const leftText = Array.from({ length: rnd(12) }, line).join('\n');
    const rightText = Array.from({ length: rnd(12) }, line).join('\n');
    const diff = diffLines(leftText, rightText, { minOverlap: 0 });
    if (!diff.truncated && applyEdits(diff).join('\n') !== rightText) unrelatedBad++;
  }
  eq(unrelatedBad, 0, 'and for unrelated pairs too (600 of them)');
}

/* ---- the shapes that break naive implementations ---- */

{
  const editsOf = (a, b, options) => diffLines(a, b, options).edits.map((e) => e.op).join(',');

  eq(editsOf('a\nb\nc', 'a\nb\nc'), 'equal,equal,equal', 'identical text is all equal');
  eq(editsOf('', 'a\nb'), 'insert,insert', 'empty against text is all inserts');
  eq(editsOf('a\nb', ''), 'delete,delete', 'text against empty is all deletes');
  eq(editsOf('', ''), '', 'two empties produce no edits');
  eq(editsOf('a\nb\nc', 'a\nc'), 'equal,delete,equal', 'a removed middle line');
  eq(editsOf('a\nc', 'a\nb\nc'), 'equal,insert,equal', 'an added middle line');

  // Trimming the common ends must not change the answer.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const changed = [...long];
  changed[20] = 'CHANGED';
  const trimmed = diffLines(long.join('\n'), changed.join('\n'));
  const untrimmed = diffLines(long.join('\n'), changed.join('\n'), { minOverlap: 0 });
  eq(
    trimmed.edits.map((e) => e.op).join(','),
    untrimmed.edits.map((e) => e.op).join(','),
    'prefix/suffix trimming yields the same edit script',
  );
  eq(applyEdits(trimmed).join('\n'), changed.join('\n'), 'and still reproduces the right side');
}

/* ---- options actually change the result ---- */

{
  const changes = (a, b, options) =>
    diffLines(a, b, options).edits.filter((e) => e.op !== 'equal').length;

  ok(changes('Hello', 'hello') > 0, 'case matters by default');
  eq(changes('Hello', 'hello', { ignoreCase: true }), 0, 'and can be ignored');

  ok(changes('a  b', 'a b') > 0, 'whitespace matters by default');
  eq(changes('a  b', 'a b', { ignoreWhitespace: true }), 0, 'and can be ignored');

  ok(changes('a\n\nb', 'a\nb') > 0, 'a blank line is a difference by default');
  eq(changes('a\n\nb', 'a\nb', { ignoreBlankLines: true }), 0, 'and can be ignored');

  // Ignoring blank lines must still report REAL line numbers, or the gutter
  // would point at the wrong line in the textarea.
  const diff = diffLines('a\n\n\nZ', 'a\n\n\nY', { ignoreBlankLines: true });
  const deletion = diff.edits.find((e) => e.op === 'delete');
  eq(deletion.a, 3, 'a line number survives blank-line skipping');
  eq(diff.left[deletion.a], 'Z', 'and points at the right line');

  // EQUAL rows need real line numbers too. Nothing covered them, and mapping
  // the filtered index straight through went unnoticed: it reports the
  // position within the non-blank lines, not the line in the textarea.
  const equalRows = diffLines('a\n\n\nb\nZ', 'a\n\n\nb\nY', { ignoreBlankLines: true }).edits
    .filter((edit) => edit.op === 'equal');
  deep(equalRows.map((edit) => edit.a), [0, 3], 'equal rows keep the real left line numbers');
  deep(equalRows.map((edit) => edit.b), [0, 3], 'and the real right ones');
}

/* ---- word level ---- */

{
  deep(splitWords('a b'), ['a', ' ', 'b'], 'separators are kept as tokens');
  deep(splitWords(''), [], 'empty text has no words');
  eq(splitWords('  a  ').join(''), '  a  ', 'rebuilding from tokens loses no spacing');

  const parts = diffWords('the quick brown fox', 'the slow brown fox');
  eq(parts.left.map((p) => p.text).join(''), 'the quick brown fox', 'the left side rebuilds exactly');
  eq(parts.right.map((p) => p.text).join(''), 'the slow brown fox', 'and the right side too');
  ok(
    parts.left.some((p) => p.op === 'delete' && p.text.includes('quick')),
    'the changed word is marked on the left',
  );
  ok(
    parts.right.some((p) => p.op === 'insert' && p.text.includes('slow')),
    'and on the right',
  );
  ok(
    parts.left.some((p) => p.op === 'equal' && p.text.includes('brown')),
    'the unchanged words are not marked',
  );

  const same = diffWords('identical line', 'identical line');
  ok(same.left.every((p) => p.op === 'equal'), 'an unchanged line has no marked words');
}

/* ---- display rows and stats ---- */

{
  const result = compareTexts('one\ntwo\nthree', 'one\ntwo changed\nthree');
  deep(result.rows.map((r) => r.op), ['equal', 'replace', 'equal'], 'a modified line is one replace row');
  eq(result.identical, false, 'and the sides are not identical');
  eq(result.stats.changed, 1, 'counted as changed');
  eq(result.stats.added, 0, 'not as an addition');
  eq(result.stats.removed, 0, 'nor a removal');
  eq(result.stats.unchanged, 2, 'two lines came through');
  // The left side has ONE segment here, because nothing was deleted from it —
  // 'two' -> 'two changed' is a pure insertion. Assert what is true: the
  // segments rebuild each side, and the addition is marked on the right.
  eq(
    result.rows[1].leftParts.map((part) => part.text).join(''),
    'two',
    'the replace row rebuilds its left side from segments',
  );
  eq(
    result.rows[1].rightParts.map((part) => part.text).join(''),
    'two changed',
    'and its right side',
  );
  ok(
    result.rows[1].rightParts.some((part) => part.op === 'insert'),
    'with the added words marked',
  );
  eq(result.rows[1].leftNumber, 2, 'with the left line number');
  eq(result.rows[1].rightNumber, 2, 'and the right one');

  const identical = compareTexts('same\ntext', 'same\ntext');
  eq(identical.identical, true, 'identical input is reported as such');
  eq(identical.stats.similarity, 1, 'at 100% similarity');

  // An unequal number of deletions and insertions: the surplus stays plain.
  const lopsided = compareTexts('a\nb\nc', 'X');
  const ops = lopsided.rows.map((r) => r.op);
  eq(ops.filter((op) => op === 'replace').length, 1, 'one line pairs up as a replace');
  eq(ops.filter((op) => op === 'delete').length, 2, 'and the surplus deletions stay deletions');

  const empty = compareTexts('', '');
  eq(empty.identical, true, 'two empty sides are identical');
  eq(empty.rows.length, 0, 'with no rows');
}

/* ---- the guards that keep it responsive ---- */

{
  const line = (i) => `line ${i} with some words`;
  const build = (n, edit) => Array.from({ length: n }, (_, i) => edit(i) ?? line(i)).join('\n');

  // Unrelated text is the pathological case for Myers, and is caught in O(N+M)
  // by the overlap check rather than by exhausting the edit budget.
  const unrelated = compareTexts(build(600, () => null), build(600, (i) => `entirely other ${i}`));
  eq(unrelated.truncated, true, 'unrelated text is reported whole rather than diffed');

  // Overlapping text of the same size is NOT caught by that check.
  const overlapping = compareTexts(build(600, () => null), build(600, (i) => (i % 50 === 0 ? `EDIT ${i}` : null)));
  eq(overlapping.truncated, false, 'similar text of the same size is diffed properly');
  eq(overlapping.stats.changed, 12, 'and every change is found');

  // Small inputs are never short-circuited, however different they are.
  const small = compareTexts('a\nb\nc', 'x\ny\nz');
  eq(small.truncated, false, 'a small unrelated pair is still diffed');

  ok(DEFAULT_MAX_EDITS > 0 && DEFAULT_MAX_EDITS <= 10_000, `the edit budget is bounded (${DEFAULT_MAX_EDITS})`);
}

/* ---- unified patch output ---- */

{
  const patch = (a, b, options) => toUnifiedDiff(diffLines(a, b), options);

  eq(patch('same', 'same'), '', 'no differences produces no patch at all');

  const simple = patch('one\ntwo\nthree', 'one\nTWO\nthree');
  ok(simple.startsWith('--- left\n+++ right\n'), 'the header names both sides');
  eq(countHunks(simple), 1, 'one change is one hunk');
  ok(simple.includes('-two'), 'the removed line is marked');
  ok(simple.includes('+TWO'), 'the added line is marked');
  ok(simple.includes(' one'), 'context lines carry a leading space');
  ok(simple.endsWith('\n'), 'the patch ends with a newline');

  const named = patch('a', 'b', { leftName: 'a/f.txt', rightName: 'b/f.txt' });
  ok(named.includes('--- a/f.txt'), 'the left name is used');
  ok(named.includes('+++ b/f.txt'), 'and the right one');

  // Hunk grouping: changes further apart than twice the context are separate.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const far = [...long];
  far[2] = 'EDIT A';
  far[30] = 'EDIT B';
  eq(countHunks(patch(long.join('\n'), far.join('\n'))), 2, 'distant changes make two hunks');

  const near = [...long];
  near[10] = 'EDIT A';
  near[12] = 'EDIT B';
  eq(countHunks(patch(long.join('\n'), near.join('\n'))), 1, 'nearby changes merge into one hunk');

  // A hunk header counts lines, and a side with none is anchored at 0.
  const added = patch('', 'brand new');
  ok(/@@ -0(?:,0)? \+1 @@/.test(added), `an empty left side is anchored at 0 (${added.split('\n')[2]})`);
  const removed = patch('gone', '');
  ok(/@@ -1 \+0(?:,0)? @@/.test(removed), `an empty right side is anchored at 0 (${removed.split('\n')[2]})`);

  eq(countHunks(''), 0, 'an empty patch has no hunks');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
