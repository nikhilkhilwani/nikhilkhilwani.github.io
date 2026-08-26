/**
 * Wires a <Dropzone> component: file picker, drag-and-drop, and paste.
 *
 * Drag events are bound to the window rather than the drop target, because a
 * drop that lands a few pixels outside the dashed box otherwise navigates the
 * browser away to the raw file — the single most annoying bug in tools like
 * these.
 */

import { screenFiles, describeRejections, type Rejection } from './limits.ts';

export interface DropzoneOptions {
  /** Called with every accepted file. Never called with an empty list. */
  onFiles: (files: File[]) => void;
  /**
   * Largest single file, in bytes. Anything over it is refused before being
   * read, because the failure mode past the tab's memory ceiling is the tab
   * dying rather than an error we could catch.
   */
  maxBytes?: number;
  /** Called with what was refused for being too large. */
  onTooLarge?: (rejected: Rejection[], message: string) => void;
  /** Substring/prefix match against file.type, e.g. ['image/'] or ['application/pdf']. */
  accept?: string[];
  /**
   * Filename extensions to accept when the OS reports no MIME type at all —
   * which Windows does for .docx often enough to matter. Deriving one from the
   * MIME string cannot work for formats whose type bears no relation to their
   * extension.
   */
  extensions?: string[];
  /** Also accept files pasted into the page. */
  paste?: boolean;
  /** Called when a drop contained nothing acceptable. */
  onReject?: (count: number) => void;
}

export function initDropzone(inputId: string, options: DropzoneOptions): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) throw new Error(`initDropzone: no input with id "${inputId}"`);

  const zone = input.closest<HTMLElement>('.dz');
  const accept = options.accept ?? [];

  const extensions = (options.extensions ?? []).map((e) =>
    e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
  );

  const matches = (file: File): boolean => {
    if (!accept.length && !extensions.length) return true;

    const byExtension = extensions.some((e) => file.name.toLowerCase().endsWith(e));
    if (byExtension) return true;

    // Some systems report an empty type for less common formats; the extension
    // list above is the reliable fallback for those.
    if (!file.type) return false;
    return accept.some((a) => file.type.startsWith(a));
  };

  const emit = (list: FileList | File[] | null | undefined) => {
    const all = Array.from(list ?? []);
    if (!all.length) return;
    const ok = all.filter(matches);
    if (!ok.length) {
      options.onReject?.(all.length);
      return;
    }
    if (ok.length < all.length) options.onReject?.(all.length - ok.length);

    // Size screening happens after type screening so the messages stay
    // specific: "not an image" and "too large" are different problems.
    if (options.maxBytes === undefined) {
      options.onFiles(ok);
      return;
    }
    const { accepted, rejected } = screenFiles(ok, { perFile: options.maxBytes });
    if (rejected.length) options.onTooLarge?.(rejected, describeRejections(rejected));
    if (accepted.length) options.onFiles(accepted);
  };

  input.addEventListener('change', () => {
    emit(input.files);
    // Reset so picking the same file twice in a row still fires `change`.
    input.value = '';
  });

  // Depth counter: dragenter/dragleave also fire for child elements, so a
  // naive toggle flickers the highlight as the pointer crosses the icon.
  let depth = 0;
  const setOver = (on: boolean) => {
    if (!zone) return;
    if (on) zone.setAttribute('data-over', '');
    else zone.removeAttribute('data-over');
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    setOver(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    // Required, or the browser opens the file instead of firing `drop`.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setOver(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setOver(false);
    emit(e.dataTransfer?.files);
  });

  if (options.paste) {
    window.addEventListener('paste', (e) => {
      const items = (e as ClipboardEvent).clipboardData?.files;
      if (items?.length) emit(items);
    });
  }
}
