/** Blob -> "Save as" without a server round trip. */

/**
 * Triggers a download of `blob` as `filename`.
 *
 * The object URL is revoked on a timer rather than immediately: Firefox and
 * some Chromium builds cancel an in-flight download if the URL dies in the
 * same task as the click.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

/**
 * Packs entries into a ZIP with fflate, loaded on demand.
 *
 * Level 0 (store) is deliberate: JPEG, PNG, WebP, and PDF are already
 * compressed, so deflating them costs seconds of main-thread time to save
 * a fraction of a percent.
 */
export async function zipFiles(entries: { name: string; data: Uint8Array }[]): Promise<Blob> {
  const { zipSync } = await import('fflate');
  const bag: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const entry of entries) bag[entry.name] = [entry.data, { level: 0 }];
  const packed = zipSync(bag);
  // Copy into a fresh ArrayBuffer so the Blob is not tied to fflate's view.
  return new Blob([packed.slice()], { type: 'application/zip' });
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
