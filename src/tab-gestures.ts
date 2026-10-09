interface TabGestures {
  select(): void; hold(): void; drag?(clientX: number): void;
  finish?(): void; scroll?: HTMLElement; dragging?(): void;
}
/** Touch hold opens actions; only movement after the hold rearranges a tab. */
export function tabGestures(element: HTMLElement, actions: TabGestures) {
  let press: { id: number; x: number; y: number; scroll: number; held: boolean; dragged: boolean; moved: boolean } | undefined;
  let timer: ReturnType<typeof setTimeout>, suppress = false;
  const finish = () => {
    clearTimeout(timer); if (press) suppress = press.held || press.moved;
    element.classList.remove('dragging'); press = undefined; actions.finish?.();
  };
  element.addEventListener('pointerdown', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (event.button !== 0 || button && button !== element) return;
    suppress = false; press = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: actions.scroll?.scrollLeft || 0, held: false, dragged: false, moved: false };
    element.setPointerCapture(event.pointerId);
    timer = setTimeout(() => { if (press && !press.moved) { press.held = true; suppress = true; actions.hold(); } }, 450);
  });
  element.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x, dy = event.clientY - press.y;
    if (Math.hypot(dx, dy) < 8 && !press.dragged) return;
    if (press.held && actions.drag) {
      event.preventDefault();
      if (!press.dragged) { press.dragged = true; element.classList.add('dragging'); actions.dragging?.(); }
      actions.drag(event.clientX);
      // Reordering reparents the element, which can release pointer capture.
      if (element.isConnected) element.setPointerCapture(event.pointerId);
      return;
    }
    press.moved = true; clearTimeout(timer);
    if (actions.scroll && Math.abs(dx) >= Math.abs(dy)) { event.preventDefault(); actions.scroll.scrollLeft = press.scroll - dx; }
  });
  element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish);
  element.addEventListener('click', event => { if (suppress) { event.preventDefault(); event.stopPropagation(); suppress = false; return; } actions.select(); });
  element.addEventListener('contextmenu', event => { event.preventDefault(); actions.hold(); });
  element.addEventListener('keydown', event => {
    if (event.key === 'F10' && event.shiftKey || event.key === 'ContextMenu') { event.preventDefault(); actions.hold(); }
  });
}
