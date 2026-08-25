/**
 * sRGB / HSL / HSV / CMYK / OKLCH conversion. Pure functions, no dependencies —
 * this whole module is a few hundred bytes of shipped JS.
 *
 * Channel ranges: RGB 0-255, HSL/HSV h 0-360 and s/l/v 0-100, CMYK 0-100,
 * OKLCH l 0-1, c 0-0.4ish, h 0-360.
 */

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }
export interface HSV { h: number; s: number; v: number }
export interface CMYK { c: number; m: number; y: number; k: number }
export interface OKLCH { l: number; c: number; h: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/* ------------------------------------------------------------------ hex ---- */

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): RGB | null {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split('').map((c) => c + c).join('');
  if (s.length === 8) s = s.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/* ------------------------------------------------------------------ hsl ---- */

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: round(h, 1), s: round(s * 100, 1), l: round(l * 100, 1) };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  const seg = Math.floor(hn / 60) % 6;
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r1, g1, b1] = table[seg]!;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/* ------------------------------------------------------------------ hsv ---- */

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: round(h, 1), s: round((max === 0 ? 0 : d / max) * 100, 1), v: round(max * 100, 1) };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const vn = clamp(v, 0, 100) / 100;

  const c = vn * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vn - c;

  const seg = Math.floor(hn / 60) % 6;
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r1, g1, b1] = table[seg]!;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/* ----------------------------------------------------------------- cmyk ---- */

export function rgbToCmyk({ r, g, b }: RGB): CMYK {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: round(((1 - rn - k) / (1 - k)) * 100, 1),
    m: round(((1 - gn - k) / (1 - k)) * 100, 1),
    y: round(((1 - bn - k) / (1 - k)) * 100, 1),
    k: round(k * 100, 1),
  };
}

export function cmykToRgb({ c, m, y, k }: CMYK): RGB {
  const cn = clamp(c, 0, 100) / 100, mn = clamp(m, 0, 100) / 100;
  const yn = clamp(y, 0, 100) / 100, kn = clamp(k, 0, 100) / 100;
  return {
    r: Math.round(255 * (1 - cn) * (1 - kn)),
    g: Math.round(255 * (1 - mn) * (1 - kn)),
    b: Math.round(255 * (1 - yn) * (1 - kn)),
  };
}

/* ---------------------------------------------------------------- oklch ---- */
// Björn Ottosson's OKLab, via linear sRGB.

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: RGB): OKLCH {
  const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.sqrt(A * A + B * B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;

  return { l: round(L, 4), c: round(c, 4), h: round(c < 1e-4 ? 0 : h, 1) };
}

export function oklchToRgb({ l, c, h }: OKLCH): RGB {
  const hr = (h * Math.PI) / 180;
  const A = Math.cos(hr) * c;
  const B = Math.sin(hr) * c;

  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;

  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;

  const lr = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const lg = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const lb = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  return {
    r: Math.round(clamp(linearToSrgb(lr), 0, 1) * 255),
    g: Math.round(clamp(linearToSrgb(lg), 0, 1) * 255),
    b: Math.round(clamp(linearToSrgb(lb), 0, 1) * 255),
  };
}

/** True when an OKLCH triple sits outside the sRGB gamut, i.e. the swatch you
 *  see is a clipped approximation of what you typed. */
export function isOutOfSrgbGamut({ l, c, h }: OKLCH): boolean {
  const hr = (h * Math.PI) / 180;
  const A = Math.cos(hr) * c, B = Math.sin(hr) * c;
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const ch = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map(linearToSrgb);
  return ch.some((v) => v < -0.002 || v > 1.002);
}

/* ----------------------------------------------------------- named colors -- */

/** Common CSS named colors, for name input and nearest-name output. */
export const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', silver: '#c0c0c0', gray: '#808080',
  maroon: '#800000', olive: '#808000', green: '#008000', purple: '#800080', teal: '#008080',
  navy: '#000080', orange: '#ffa500', gold: '#ffd700', pink: '#ffc0cb', hotpink: '#ff69b4',
  crimson: '#dc143c', salmon: '#fa8072', tomato: '#ff6347', coral: '#ff7f50',
  orangered: '#ff4500', firebrick: '#b22222', darkred: '#8b0000', indianred: '#cd5c5c',
  brown: '#a52a2a', sienna: '#a0522d', chocolate: '#d2691e', peru: '#cd853f',
  tan: '#d2b48c', wheat: '#f5deb3', beige: '#f5f5dc', khaki: '#f0e68c',
  ivory: '#fffff0', linen: '#faf0e6', snow: '#fffafa', seashell: '#fff5ee',
  lavender: '#e6e6fa', plum: '#dda0dd', violet: '#ee82ee', orchid: '#da70d6',
  fuchsia: '#ff00ff', indigo: '#4b0082', darkviolet: '#9400d3', blueviolet: '#8a2be2',
  slateblue: '#6a5acd', royalblue: '#4169e1', dodgerblue: '#1e90ff', deepskyblue: '#00bfff',
  skyblue: '#87ceeb', lightblue: '#add8e6', steelblue: '#4682b4', cadetblue: '#5f9ea0',
  turquoise: '#40e0d0', aquamarine: '#7fffd4', mediumseagreen: '#3cb371',
  seagreen: '#2e8b57', forestgreen: '#228b22', darkgreen: '#006400',
  olivedrab: '#6b8e23', yellowgreen: '#9acd32', chartreuse: '#7fff00',
  springgreen: '#00ff7f', mintcream: '#f5fffa', honeydew: '#f0fff0',
  midnightblue: '#191970', darkslategray: '#2f4f4f', dimgray: '#696969',
  slategray: '#708090', lightgray: '#d3d3d3', gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5', aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff',
};

const NAMED_RGB = Object.entries(NAMED).map(([name, hex]) => ({ name, rgb: hexToRgb(hex)! }));

/** Closest named color by plain squared distance in sRGB, plus whether it is exact. */
export function nearestNamed(rgb: RGB): { name: string; exact: boolean } {
  let best = NAMED_RGB[0]!;
  let bestD = Infinity;
  for (const cand of NAMED_RGB) {
    const d =
      (cand.rgb.r - rgb.r) ** 2 + (cand.rgb.g - rgb.g) ** 2 + (cand.rgb.b - rgb.b) ** 2;
    if (d < bestD) { bestD = d; best = cand; }
  }
  return { name: best.name, exact: bestD === 0 };
}

/* --------------------------------------------------------------- parsing ---- */

/**
 * Accepts hex, rgb(), hsl(), hsv(), cmyk(), oklch() and named colors, in both
 * comma and space separated forms. Returns null on anything unrecognised so the
 * caller can show an inline error rather than silently rendering black.
 */
export function parseColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  if (s in NAMED) return hexToRgb(NAMED[s]!);
  if (/^#?[0-9a-f]{3,8}$/.test(s) && (s.startsWith('#') || /^[0-9a-f]{6}$/.test(s))) {
    const hit = hexToRgb(s);
    if (hit) return hit;
  }

  const fn = s.match(/^([a-z]+)\s*\(([^)]*)\)$/);
  if (!fn) return null;
  const name = fn[1]!;
  const parts = fn[2]!
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((p) => parseFloat(p.replace('%', '')));
  if (parts.some((p) => Number.isNaN(p))) return null;

  const [a = 0, b = 0, c = 0, d = 0] = parts;

  switch (name) {
    case 'rgb':
    case 'rgba':
      return { r: clamp(a, 0, 255), g: clamp(b, 0, 255), b: clamp(c, 0, 255) };
    case 'hsl':
    case 'hsla':
      return hslToRgb({ h: a, s: b, l: c });
    case 'hsv':
    case 'hsb':
      return hsvToRgb({ h: a, s: b, v: c });
    case 'cmyk':
      return cmykToRgb({ c: a, m: b, y: c, k: d });
    case 'oklch':
      // Accepts l as 0-1 or as a percentage.
      return oklchToRgb({ l: a > 1 ? a / 100 : a, c: b, h: c });
    default:
      return null;
  }
}

/* -------------------------------------------------------------- formatting -- */

export const fmt = {
  hex: (rgb: RGB) => rgbToHex(rgb),
  rgb: ({ r, g, b }: RGB) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`,
  hsl: (rgb: RGB) => {
    const { h, s, l } = rgbToHsl(rgb);
    return `hsl(${h}, ${s}%, ${l}%)`;
  },
  hsv: (rgb: RGB) => {
    const { h, s, v } = rgbToHsv(rgb);
    return `hsv(${h}, ${s}%, ${v}%)`;
  },
  cmyk: (rgb: RGB) => {
    const { c, m, y, k } = rgbToCmyk(rgb);
    return `cmyk(${c}%, ${m}%, ${y}%, ${k}%)`;
  },
  oklch: (rgb: RGB) => {
    const { l, c, h } = rgbToOklch(rgb);
    return `oklch(${round(l * 100, 2)}% ${c} ${h})`;
  },
};
