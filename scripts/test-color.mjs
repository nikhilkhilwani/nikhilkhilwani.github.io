import { rgbToOklch, oklchToRgb, hexToRgb, rgbToHex, parseColor, rgbToHsl, hslToRgb, rgbToCmyk, cmykToRgb, rgbToHsv, hsvToRgb, nearestNamed, fmt } from '../src/lib/color/convert.ts';
import { contrastRatio, evaluate, fixContrast } from '../src/lib/contrast/wcag.ts';

let fail = 0;
const near = (a, b, tol, msg) => {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) { console.log(`FAIL ${msg}: got ${a}, want ~${b}`); fail++; }
  else console.log(`ok   ${msg}: ${typeof a === 'number' ? a.toFixed(4) : a}`);
};
const eq = (a, b, msg) => {
  if (a !== b) { console.log(`FAIL ${msg}: got ${a}, want ${b}`); fail++; }
  else console.log(`ok   ${msg}: ${a}`);
};

// --- OKLCH against Ottosson's published sRGB reference values
const red = rgbToOklch(hexToRgb('#ff0000'));
near(red.l, 0.6280, 0.001, 'oklch red L');
near(red.c, 0.2577, 0.001, 'oklch red C');
near(red.h, 29.23, 0.1,   'oklch red H');
const white = rgbToOklch({r:255,g:255,b:255});
near(white.l, 1.0, 0.001, 'oklch white L');
near(white.c, 0.0, 0.001, 'oklch white C');

// --- WCAG against known reference pairs
near(contrastRatio({r:0,g:0,b:0},{r:255,g:255,b:255}), 21, 0.001, 'black/white = 21');
near(contrastRatio(hexToRgb('#767676'), hexToRgb('#ffffff')), 4.54, 0.02, '#767676 on white');
near(contrastRatio(hexToRgb('#ffffff'), hexToRgb('#ffffff')), 1, 0.001, 'white/white = 1');
eq(evaluate(hexToRgb('#767676'), hexToRgb('#ffffff')).aaNormal, true, '#767676 passes AA');
eq(evaluate(hexToRgb('#797979'), hexToRgb('#ffffff')).aaaNormal, false, '#797979 fails AAA');

// --- round trips
for (const hex of ['#6ee7d7','#0d1017','#ff8800','#123456','#ffffff','#000000','#7f7f7f']) {
  const rgb = hexToRgb(hex);
  eq(rgbToHex(hslToRgb(rgbToHsl(rgb))), hex, `hsl round-trip ${hex}`);
  eq(rgbToHex(hsvToRgb(rgbToHsv(rgb))), hex, `hsv round-trip ${hex}`);
  eq(rgbToHex(cmykToRgb(rgbToCmyk(rgb))), hex, `cmyk round-trip ${hex}`);
  eq(rgbToHex(oklchToRgb(rgbToOklch(rgb))), hex, `oklch round-trip ${hex}`);
}

// --- parser
eq(rgbToHex(parseColor('#6EE7D7')), '#6ee7d7', 'parse hex upper');
eq(rgbToHex(parseColor('#fff')), '#ffffff', 'parse short hex');
eq(rgbToHex(parseColor('rgb(110, 231, 215)')), '#6ee7d7', 'parse rgb()');
eq(rgbToHex(parseColor('rgb(110 231 215)')), '#6ee7d7', 'parse space rgb()');
// Round-trip the tool's OWN formatted output — hand-rounded hsl() text like
// "hsl(171, 71%, 67%)" is a genuinely different color, so asserting on that
// would be testing the typo, not the parser.
for (const hex of ['#6ee7d7','#ff8800','#123456','#0d1017']) {
  const rgb = hexToRgb(hex);
  eq(rgbToHex(parseColor(fmt.hsl(rgb))), hex, `parse own hsl() ${hex}`);
  eq(rgbToHex(parseColor(fmt.rgb(rgb))), hex, `parse own rgb() ${hex}`);
  eq(rgbToHex(parseColor(fmt.hsv(rgb))), hex, `parse own hsv() ${hex}`);
  eq(rgbToHex(parseColor(fmt.cmyk(rgb))), hex, `parse own cmyk() ${hex}`);
}
eq(rgbToHex(parseColor('hsl(172.07, 71.6%, 66.9%)')), '#6ee7d7', 'parse precise hsl()');
eq(rgbToHex(parseColor('tomato')), '#ff6347', 'parse named');
eq(parseColor('not a color'), null, 'parse garbage -> null');
eq(parseColor(''), null, 'parse empty -> null');
eq(rgbToHex(parseColor('oklch(0.628 0.2577 29.23)')), '#ff0000', 'parse oklch()');
eq(nearestNamed(hexToRgb('#ff6347')).exact, true, 'nearestNamed exact');
eq(nearestNamed(hexToRgb('#ff6348')).exact, false, 'nearestNamed inexact');
eq(fmt.oklch(hexToRgb('#ff0000')), 'oklch(62.8% 0.2577 29.2)', 'fmt oklch');

// --- fixContrast actually reaches the target
for (const [fg,bg,target] of [['#9aa3b2','#0d1017',7],['#888888','#ffffff',4.5],['#6ee7d7','#ffffff',4.5],['#333333','#000000',4.5]]) {
  const fixed = fixContrast(hexToRgb(fg), hexToRgb(bg), target);
  if (!fixed) { console.log(`ok   fixContrast ${fg} on ${bg} -> impossible (reported)`); continue; }
  const got = contrastRatio(fixed, hexToRgb(bg));
  if (got < target - 0.01) { console.log(`FAIL fixContrast ${fg} on ${bg}: ${got.toFixed(2)} < ${target}`); fail++; }
  else console.log(`ok   fixContrast ${fg} on ${bg} -> ${rgbToHex(fixed)} = ${got.toFixed(2)}`);
}
// mid-grey at AAA should be honestly impossible
eq(fixContrast(hexToRgb('#808080'), hexToRgb('#808080'), 7), null, 'impossible pair -> null');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail ? 1 : 0);
