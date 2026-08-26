/**
 * Canvas-based image decode/encode. The browser already ships the codecs, so
 * the image tools need no WASM and no upload — this is the whole engine.
 *
 * fitWithin() is pure and covered by scripts/test-tools.mjs; the rest needs a
 * DOM and is exercised in the browser.
 */

export interface Size {
  width: number;
  height: number;
}

/**
 * Scales `src` down to fit inside a `max` box, preserving aspect ratio.
 * Never scales up, and never returns a zero dimension (a 1000x10 image capped
 * at 100 would otherwise round its height to 0 and encode as a blank strip).
 */
export function fitWithin(src: Size, max: number | null): Size {
  const { width, height } = src;
  if (!max || max <= 0 || (width <= max && height <= max)) {
    return { width, height };
  }
  const scale = Math.min(max / width, max / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when the browser can actually encode `type` — not all can do WebP. */
export async function canEncode(type: string): Promise<boolean> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, 0.5);
    });
    // A canvas that cannot honour the request silently falls back to PNG.
    return !!blob && blob.type === type;
  } catch {
    return false;
  }
}

/**
 * Decodes a file to something drawable. Prefers createImageBitmap (decodes off
 * the main thread); falls back to an <img> for browsers or formats it rejects,
 * which also covers SVG.
 */
export async function decodeImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through — Safari has historically refused some formats here.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = 'sync';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Not an image this browser can read'));
      img.src = url;
    });
  } finally {
    // Safe here: the decoded pixels are retained independently of the URL.
    URL.revokeObjectURL(url);
  }
}

export function sizeOf(image: ImageBitmap | HTMLImageElement): Size {
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  return { width, height };
}

/** Releases an ImageBitmap's memory immediately rather than waiting for GC. */
export function releaseImage(image: ImageBitmap | HTMLImageElement): void {
  if ('close' in image && typeof image.close === 'function') image.close();
}

export interface DrawOptions {
  /** Painted behind the image — matters when flattening alpha into JPEG. */
  background?: string;
}

/** Draws `image` into a new canvas at exactly `size`. */
export function drawToCanvas(
  image: ImageBitmap | HTMLImageElement,
  size: Size,
  { background }: DrawOptions = {},
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.drawImage(image, 0, 0, size.width, size.height);
  return canvas;
}

/** Promise wrapper around canvas.toBlob, with a clear failure message. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Could not encode as ${type}`))),
      type,
      quality,
    );
  });
}

export interface ConvertRequest {
  file: File;
  type: string;
  /** 0–1, ignored for PNG. */
  quality: number;
  /** Longest-edge cap in pixels, or null to keep the original size. */
  maxEdge: number | null;
  /** Flattened behind the image for formats without alpha. */
  background?: string;
}

export interface ConvertResult {
  blob: Blob;
  from: Size;
  to: Size;
}

/** Decode -> optionally resize -> re-encode. Always frees the decoded bitmap. */
export async function convertImage({
  file,
  type,
  quality,
  maxEdge,
  background,
}: ConvertRequest): Promise<ConvertResult> {
  const image = await decodeImage(file);
  try {
    const from = sizeOf(image);
    if (!from.width || !from.height) throw new Error('Image has no dimensions');

    const to = fitWithin(from, maxEdge);
    // JPEG has no alpha channel: without a fill, transparent pixels turn black.
    const canvas = drawToCanvas(image, to, {
      background: background ?? (type === 'image/jpeg' ? '#ffffff' : undefined),
    });
    const blob = await canvasToBlob(canvas, type, type === 'image/png' ? undefined : quality);

    // Let the canvas go before the next file is decoded.
    canvas.width = canvas.height = 0;
    return { blob, from, to };
  } finally {
    releaseImage(image);
  }
}
