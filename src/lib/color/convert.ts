/**
 * Color parsing into sRGB. Pure functions, no dependencies — this whole module
 * is a few hundred bytes of shipped JS.
 *
 * Only the inbound direction is here: parseColor accepts every CSS-ish syntax
 * the QR generator's color inputs might carry, so each notation needs its
 * X-to-RGB converter but not the reverse. The rgb-to-X direction and the
 * formatters went with the color converter and contrast checker tools.
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

const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

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

/* ----------------------------------------------------------- named colors -- */

/** Common CSS named colors, so parseColor accepts a name as well as a notation. */
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
