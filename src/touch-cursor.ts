interface Cell { getChars(): string; getWidth(): number }
/** Match the tracked shell line against rendered cells before moving Readline.
 * Refuse stale output or unsupported graphemes instead of moving into history. */
export function cursorSteps(text: string, cursor: number, position: number, target: number, cols: number, cell: (position: number) => Cell | undefined): number | undefined {
  const before = Array.from(text.slice(0, cursor)), after = Array.from(text.slice(cursor));
  const positions = [position];
  let at = position;
  for (const char of before.reverse()) {
    at--;
    if (cell(at)?.getWidth() === 0) at--;
    if (at < 0 || cell(at)?.getChars() !== char) return;
    positions.unshift(at);
  }
  at = position;
  for (const char of after) {
    const current = cell(at);
    if (current?.getChars() !== char || !current.getWidth()) return;
    at += current.getWidth(); positions.push(at);
  }
  if (Math.floor(target / cols) < Math.floor(positions[0] / cols) || Math.floor(target / cols) > Math.floor(at / cols)) return;
  let index = 0;
  while (index + 1 < positions.length && positions[index + 1] <= target) index++;
  return index - before.length;
}

export function touchCursor(element: HTMLElement, move: (x: number, y: number) => void) {
  let press: { x: number; y: number; at: number } | undefined;
  element.addEventListener('touchstart', event => {
    press = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, at: performance.now() } : undefined;
  }, { passive: true });
  element.addEventListener('touchmove', event => {
    if (press && (event.touches.length !== 1 || Math.hypot(event.touches[0].clientX - press.x, event.touches[0].clientY - press.y) > 8)) press = undefined;
  }, { passive: true });
  element.addEventListener('touchcancel', () => { press = undefined; });
  element.addEventListener('touchend', event => {
    const tap = press; press = undefined;
    if (tap && !event.touches.length && performance.now() - tap.at < 300) move(tap.x, tap.y);
  }, { passive: true });
}
