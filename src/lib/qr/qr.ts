/**
 * QR generation. The `qrcode` package is used for the matrix only (its
 * create() does the Reed-Solomon and masking work); rendering is ours so SVG
 * and canvas output stay identical and styleable.
 *
 * Payload builders and matrixToSvg() are pure — covered by test-tools.mjs.
 */

import { create, type QRCodeErrorCorrectionLevel } from 'qrcode';

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export const EC_LEVELS: { id: EcLevel; label: string; hint: string }[] = [
  { id: 'L', label: 'L — 7%', hint: 'Smallest code. Use for clean screens.' },
  { id: 'M', label: 'M — 15%', hint: 'Balanced. The usual choice.' },
  { id: 'Q', label: 'Q — 25%', hint: 'Survives light damage or a small logo.' },
  { id: 'H', label: 'H — 30%', hint: 'Most robust. Needed behind a logo.' },
];

export interface Matrix {
  size: number;
  /** Row-major, one byte per module: 1 = dark. */
  data: Uint8Array;
  version: number;
}

/**
 * Builds the module matrix. Throws when the payload cannot fit even at
 * version 40 — the caller shows that message verbatim.
 */
export function buildMatrix(text: string, ec: EcLevel): Matrix {
  if (!text) throw new Error('Nothing to encode yet');
  const qr = create(text, { errorCorrectionLevel: ec as QRCodeErrorCorrectionLevel });
  return {
    size: qr.modules.size,
    data: Uint8Array.from(qr.modules.data as unknown as ArrayLike<number>),
    version: qr.version,
  };
}

export const isDark = (m: Matrix, row: number, col: number): boolean =>
  m.data[row * m.size + col] === 1;

/**
 * Renders the matrix as an SVG string.
 *
 * Every dark module becomes one rect. Merging horizontal runs into a single
 * rect would halve the node count, but separate rects keep `radius` (rounded
 * dots) possible, and QR SVGs are small enough that it does not matter.
 *
 * `margin` is in modules — the spec's quiet zone is 4, and scanners get
 * unreliable below that, so the UI floor is 1 with 4 as the default.
 */
export function matrixToSvg(
  m: Matrix,
  opts: {
    scale?: number;
    margin?: number;
    dark?: string;
    light?: string;
    radius?: number;
  } = {},
): string {
  const scale = Math.max(1, Math.round(opts.scale ?? 8));
  const margin = Math.max(0, Math.round(opts.margin ?? 4));
  const dark = opts.dark ?? '#000000';
  const light = opts.light ?? '#ffffff';
  // 0..0.5 of a module; 0.5 would make each dot a circle.
  const radius = Math.min(0.5, Math.max(0, opts.radius ?? 0)) * scale;

  const modules = m.size + margin * 2;
  const side = modules * scale;

  let path = '';
  for (let row = 0; row < m.size; row++) {
    for (let col = 0; col < m.size; col++) {
      if (!isDark(m, row, col)) continue;
      const x = (col + margin) * scale;
      const y = (row + margin) * scale;
      path += radius
        ? `<rect x="${x}" y="${y}" width="${scale}" height="${scale}" rx="${round(radius)}"/>`
        : `<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"`,
    ` viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`,
    `<rect width="${side}" height="${side}" fill="${escapeAttr(light)}"/>`,
    `<g fill="${escapeAttr(dark)}">${path}</g>`,
    `</svg>`,
  ].join('');
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Colors come from <input type="color">, but never trust them into markup. */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** Draws the matrix onto a canvas at `scale` px per module. */
export function matrixToCanvas(
  m: Matrix,
  opts: { scale?: number; margin?: number; dark?: string; light?: string } = {},
): HTMLCanvasElement {
  const scale = Math.max(1, Math.round(opts.scale ?? 8));
  const margin = Math.max(0, Math.round(opts.margin ?? 4));
  const side = (m.size + margin * 2) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context');

  ctx.fillStyle = opts.light ?? '#ffffff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = opts.dark ?? '#000000';

  for (let row = 0; row < m.size; row++) {
    for (let col = 0; col < m.size; col++) {
      if (isDark(m, row, col)) {
        ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
      }
    }
  }
  return canvas;
}

/* ---------------------------------------------------------------- payloads */

/**
 * Escapes a value for the WIFI:/MECARD: micro-formats, where `\ ; , : "` are
 * structural. Getting this wrong is the classic bug: a WiFi password with a
 * semicolon silently truncates the credential.
 */
export function escapeMicroformat(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

export type WifiAuth = 'WPA' | 'WEP' | 'nopass';

export function wifiPayload(input: {
  ssid: string;
  password: string;
  auth: WifiAuth;
  hidden?: boolean;
}): string {
  const ssid = escapeMicroformat(input.ssid.trim());
  if (!ssid) return '';

  const parts = [`WIFI:S:${ssid}`, `T:${input.auth}`];
  // An open network must not carry a P: field at all.
  if (input.auth !== 'nopass' && input.password) {
    parts.push(`P:${escapeMicroformat(input.password)}`);
  }
  if (input.hidden) parts.push('H:true');
  return `${parts.join(';')};;`;
}

export interface ContactInput {
  name: string;
  org?: string;
  title?: string;
  phone?: string;
  email?: string;
  url?: string;
}

/**
 * vCard 3.0 — the version both iOS and Android import without complaint.
 * Lines are CRLF-joined because RFC 6350 requires it and some Android
 * scanners reject LF-only cards.
 */
export function vcardPayload(input: ContactInput): string {
  const name = input.name.trim();
  if (!name) return '';

  // vCard splits N into family;given;… — approximate from a display name.
  const words = name.split(/\s+/);
  const family = words.length > 1 ? words[words.length - 1] : '';
  const given = words.length > 1 ? words.slice(0, -1).join(' ') : name;

  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(family)};${esc(given)};;;`, `FN:${esc(name)}`];
  if (input.org) lines.push(`ORG:${esc(input.org)}`);
  if (input.title) lines.push(`TITLE:${esc(input.title)}`);
  if (input.phone) lines.push(`TEL;TYPE=CELL:${esc(input.phone)}`);
  if (input.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(input.email)}`);
  if (input.url) lines.push(`URL:${esc(input.url)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

/** vCard escaping: backslash, comma, semicolon, and literal newlines. */
function esc(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');
}

export function emailPayload(input: { to: string; subject?: string; body?: string }): string {
  const to = input.to.trim();
  if (!to) return '';
  const query = new URLSearchParams();
  if (input.subject?.trim()) query.set('subject', input.subject.trim());
  if (input.body?.trim()) query.set('body', input.body.trim());
  const qs = query.toString();
  // URLSearchParams uses + for spaces; mailto handlers want %20.
  return `mailto:${to}${qs ? `?${qs.replace(/\+/g, '%20')}` : ''}`;
}

/**
 * Adds a scheme to something that looks like a bare domain, so scanning a
 * code made from "example.com" opens a browser instead of a search.
 */
export function normalizeUrlish(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}
