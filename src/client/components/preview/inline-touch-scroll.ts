/** Route one-finger drags at fit to the containing transcript, not the image.
 * Owning the touch from pointerdown keeps Android from cancelling a later pinch.
 */
export function scrollPreviewAncestors(element: HTMLElement, delta: number): number {
  let remaining = delta;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    const before = parent.scrollTop;
    const maximum = Math.max(0, parent.scrollHeight - parent.clientHeight);
    parent.scrollTop = Math.max(0, Math.min(maximum, before + remaining));
    remaining -= parent.scrollTop - before;
    if (Math.abs(remaining) < 0.1 || /contain|none/.test(style.overscrollBehaviorY)) break;
  }
  return delta - remaining;
}
