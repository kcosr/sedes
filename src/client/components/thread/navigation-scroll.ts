/** Animate short navigation hops, but jump when the destination is more than
 * two visible pages away so long transcripts do not spend seconds scrolling. */
export function navigationScrollBehavior(
  element: HTMLElement,
  destination: number,
  requestedBehavior?: ScrollBehavior,
): ScrollBehavior {
  if (requestedBehavior === "auto") return "auto";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "auto";
  }
  const naturalMaximum = Math.max(
    0,
    element.scrollHeight - element.clientHeight,
  );
  const clampedDestination = Math.min(
    naturalMaximum,
    Math.max(0, destination),
  );
  return Math.abs(clampedDestination - element.scrollTop) <=
    2 * element.clientHeight
    ? "smooth"
    : "auto";
}
