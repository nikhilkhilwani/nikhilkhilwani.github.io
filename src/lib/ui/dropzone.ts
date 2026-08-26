/**
 * Wires a <Dropzone> component: file picker, drag-and-drop, and paste.
 *
 * Drag events are bound to the window rather than the drop target, because a
 * drop that lands a few pixels outside the dashed box otherwise navigates the
 * browser away to the raw file — the single most annoying bug in tools like
 * these.
 */

export interface DropzoneOptions {
  /** Called with every accepted file. Never called with an empty list. */
  onFiles: (files: File[]) => void;
  /** Substring/prefix match against file.type, e.g. ['image/'] or ['application/pdf']. */
  accept?: string[];
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

  const matches = (file: File): boolean => {
    if (!accept.length) return true;
    // Some browsers report an empty type for uncommon extensions; fall back to
    // the filename so those are not silently dropped.
    if (!file.type) {
      return accept.some((a) => file.name.toLowerCase().endsWith(a.replace(/^.*\//, '.')));
    }
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
    options.onFiles(ok);
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
