/** Small DOM helpers. */

/**
 * A plain left click (no modifier, not already handled). In-app links act
 * on it and leave modifier/middle clicks to the browser (their real href:
 * new tab, new window, download).
 */
export function isPlainClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !e.defaultPrevented &&
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  );
}

/** Is there a non-empty text selection (the user was selecting, not clicking)? */
export function hasTextSelection(): boolean {
  const selection =
    typeof window !== "undefined" ? window.getSelection() : null;
  return !!selection && !selection.isCollapsed && selection.toString() !== "";
}
