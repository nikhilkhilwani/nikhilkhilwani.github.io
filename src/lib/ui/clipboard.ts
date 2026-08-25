/** Shared copy + toast used by every tool. Imported by tool islands only. */

let hideTimer: number | undefined;

export function toast(message: string): void {
  const host = document.getElementById('toast');
  const bubble = host?.querySelector('span');
  if (!bubble) return;

  bubble.textContent = message;
  bubble.setAttribute('data-show', '');
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => bubble.removeAttribute('data-show'), 1600);
}

export async function copy(text: string, label = 'Copied'): Promise<void> {
  try {
    // navigator.clipboard is unavailable on insecure origins and in some
    // in-app browsers, so fall back to the old execCommand path.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(`${label}: ${text.length > 28 ? text.slice(0, 27) + '…' : text}`);
  } catch {
    toast("Couldn't copy — select and copy manually");
  }
}

/**
 * Delegated handler: any element with [data-copy] copies its own value.
 * One listener for the whole page, and it keeps working for nodes added later.
 */
export function bindCopy(root: ParentNode = document): void {
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy]');
    if (!el) return;
    const value = el.dataset.copy || el.textContent?.trim() || '';
    if (value) void copy(value, el.dataset.copyLabel || 'Copied');
  });
}
