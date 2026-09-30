const LIST_STEPS: Readonly<Record<string, "first" | "last" | 1 | -1>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

/**
 * Arrow-key movement for a custom list whose rows each have one main button
 * (a trailing row action stays a Tab stop): Up and Down step between the
 * enabled main buttons and wrap, Home and End jump to the ends. Focus on a
 * row's trailing action counts as focus on that row. Returns whether the key
 * moved focus, so the caller can prevent its default.
 */
export function moveListFocus(
  items: readonly HTMLElement[],
  key: string,
  from: Element | null = document.activeElement,
): boolean {
  const step = LIST_STEPS[key];
  const enabled = items.filter((item) => !item.matches(":disabled"));
  if (step === undefined || enabled.length === 0) return false;
  const current = enabled.findIndex(
    (item) => item === from || (from !== null && item.parentElement?.contains(from)),
  );
  const next =
    step === "first" ? 0
    : step === "last" ? enabled.length - 1
    : current < 0 ? (step === 1 ? 0 : enabled.length - 1)
    : (current + step + enabled.length) % enabled.length;
  enabled[next]!.focus();
  return true;
}
