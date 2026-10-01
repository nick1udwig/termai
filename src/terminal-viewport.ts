import type { Terminal } from 'ghostty-web';

/** Keep the visible history anchored when layout or incoming output changes.
 * Ghostty measures scroll position from the bottom and resets it on writes. */
export function preserveScrollback(term: Terminal, update: () => void) {
  const buffer = term.buffer.active;
  const top = buffer.type === 'normal' && term.getViewportY() > 0
    ? buffer.length - term.rows - term.getViewportY() : undefined;
  update();
  if (top !== undefined && term.buffer.active.type === 'normal')
    term.scrollToLine(term.buffer.active.length - term.rows - top);
}
