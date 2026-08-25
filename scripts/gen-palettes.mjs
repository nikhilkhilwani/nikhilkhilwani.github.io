// Generates src/data/palettes.ts — deterministic OKLCH harmonies, tagged.
// Run: npm run palettes
import { writeFileSync } from 'node:fs';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToHex(l, c, h) {
  const hr = (h * Math.PI) / 180;
  const A = Math.cos(hr) * c;
  const B = Math.sin(hr) * c;
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const rgb = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map((v) => Math.round(clamp(linearToSrgb(v), 0, 1) * 255));
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function luminance(hex) {
  const n = hex.slice(1);
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// Mulberry32 — small, seeded, reproducible.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOODS = {
  pastel:  { l: [0.86, 0.93], c: [0.04, 0.08],  spread: 1.0 },
  vibrant: { l: [0.62, 0.74], c: [0.15, 0.21],  spread: 1.0 },
  earthy:  { l: [0.55, 0.76], c: [0.055, 0.11], spread: 0.7, hues: [30, 95] },
  muted:   { l: [0.58, 0.74], c: [0.04, 0.07],  spread: 1.0 },
  deep:    { l: [0.30, 0.47], c: [0.06, 0.13],  spread: 0.8 },
  neon:    { l: [0.76, 0.87], c: [0.19, 0.27],  spread: 1.0 },
};

const SCHEMES = {
  analogous: (h) => [h - 30, h - 15, h, h + 15, h + 30],
  complementary: (h) => [h, h + 12, h + 180, h + 192, h + 6],
  triadic: (h) => [h, h + 120, h + 240, h + 12, h + 132],
  split: (h) => [h, h + 150, h + 210, h + 8, h + 165],
  mono: (h) => [h, h, h, h, h],
};

// Calibrated against OKLCH hue angles, which differ substantially from HSL:
// ~30 reads red, ~70 amber, ~150 green, ~200 teal, ~265 blue, ~330 magenta.
const HUE_NAMES = [
  [25, 'Crimson'], [45, 'Ember'], [70, 'Amber'], [95, 'Ochre'], [120, 'Citron'],
  [145, 'Fern'], [165, 'Moss'], [185, 'Jade'], [205, 'Teal'], [228, 'Cerulean'],
  [255, 'Cobalt'], [280, 'Indigo'], [305, 'Violet'], [330, 'Mulberry'], [355, 'Rose'],
];
const hueName = (h) => {
  const n = ((h % 360) + 360) % 360;
  let best = HUE_NAMES[0];
  let bd = 999;
  for (const entry of HUE_NAMES) {
    const d = Math.min(Math.abs(entry[0] - n), 360 - Math.abs(entry[0] - n));
    if (d < bd) { bd = d; best = entry; }
  }
  return best[1];
};

const NOUNS = {
  pastel: ['Mist', 'Powder', 'Whisper', 'Chalk', 'Veil', 'Bloom'],
  vibrant: ['Signal', 'Pop', 'Flare', 'Punch', 'Beacon', 'Current'],
  earthy: ['Clay', 'Loam', 'Harvest', 'Kiln', 'Basin', 'Terrace'],
  muted: ['Linen', 'Fog', 'Dust', 'Slate', 'Quiet', 'Wash'],
  deep: ['Depth', 'Midnight', 'Cellar', 'Trench', 'Umbra', 'Vault'],
  neon: ['Arcade', 'Laser', 'Circuit', 'Voltage', 'Strobe', 'Glow'],
};

const HUE_FAMILIES = [
  [35, 'red'], [60, 'orange'], [110, 'yellow'], [175, 'green'],
  [215, 'teal'], [270, 'blue'], [320, 'purple'], [350, 'pink'], [360, 'red'],
];
const hueFamily = (h) => {
  const n = ((h % 360) + 360) % 360;
  for (const [max, name] of HUE_FAMILIES) if (n <= max) return name;
  return 'red';
};

const rand = rng(20260825);
const palettes = [];
const usedNames = new Set();
const moodKeys = Object.keys(MOODS);
const schemeKeys = Object.keys(SCHEMES);

for (let i = 0; i < 132; i++) {
  const mood = moodKeys[i % moodKeys.length];
  const cfg = MOODS[mood];
  const scheme = schemeKeys[Math.floor(rand() * schemeKeys.length)];

  const baseHue = cfg.hues
    ? cfg.hues[0] + rand() * (cfg.hues[1] - cfg.hues[0])
    : rand() * 360;

  const hues = SCHEMES[scheme](baseHue).map((h) => ((h % 360) + 360) % 360);

  const colors = hues.map((h, idx) => {
    const t = idx / 4;
    // Walk lightness across the ramp so every palette has usable light and dark ends.
    const l = cfg.l[0] + (cfg.l[1] - cfg.l[0]) * (scheme === 'mono' ? t : 0.15 + t * 0.7);
    const c = cfg.c[0] + (cfg.c[1] - cfg.c[0]) * (0.45 + rand() * 0.55) * cfg.spread;
    return oklchToHex(clamp(l, 0.06, 0.98), c, h);
  });

  const nouns = NOUNS[mood];
  let name = `${hueName(baseHue)} ${nouns[Math.floor(rand() * nouns.length)]}`;
  let n = 2;
  while (usedNames.has(name)) name = `${hueName(baseHue)} ${nouns[(n++) % nouns.length]} ${n}`;
  usedNames.add(name);

  const lums = colors.map(luminance);
  palettes.push({
    id: `p${String(i + 1).padStart(3, '0')}`,
    name,
    mood,
    scheme,
    family: hueFamily(baseHue),
    colors,
    // Cheap "is this palette light or dark overall" flag, for the filter.
    tone: lums.reduce((a, b) => a + b, 0) / lums.length > 0.32 ? 'light' : 'dark',
  });
}

const out = `// GENERATED FILE — do not edit by hand.
// Produced by scratchpad/gen-palettes.mjs (seeded, so re-running gives the same set).
// ${palettes.length} palettes as deterministic OKLCH harmonies, tagged by mood,
// harmony scheme, hue family, and overall tone.

export type Mood = ${moodKeys.map((m) => `'${m}'`).join(' | ')};
export type Scheme = ${schemeKeys.map((s) => `'${s}'`).join(' | ')};
export type Family = ${[...new Set(HUE_FAMILIES.map((f) => f[1]))].map((f) => `'${f}'`).join(' | ')};
export type Tone = 'light' | 'dark';

export interface Palette {
  id: string;
  name: string;
  mood: Mood;
  scheme: Scheme;
  family: Family;
  colors: string[];
  tone: Tone;
}

export const MOODS: Mood[] = [${moodKeys.map((m) => `'${m}'`).join(', ')}];
export const FAMILIES: Family[] = [${[...new Set(HUE_FAMILIES.map((f) => f[1]))].map((f) => `'${f}'`).join(', ')}];

export const palettes: Palette[] = ${JSON.stringify(palettes, null, 2)};
`;

writeFileSync(process.argv[2], out);
console.error(`wrote ${palettes.length} palettes`);
