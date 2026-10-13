import { useLayoutEffect, useRef, useState } from "react";

/** Reasoning yields to delivery actions, using their actual rendered widths. */
export function useComposerReasoningFit() {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [reasoningPickerOpen, setReasoningPickerOpen] = useState(false);

  const measureRef = useRef<(() => void) | undefined>(undefined);
  // React commits the new delivery controls before this layout effect. Measure
  // in that same commit, before a wider action group can paint a wrapped row.
  useLayoutEffect(() => { measureRef.current?.(); });

  useLayoutEffect(() => {
    if (!footer) return;
    const tools = footer.querySelector<HTMLElement>(".composer-tools");
    const actions = footer.querySelector<HTMLElement>(".send-group");
    if (!tools || !actions) return;
    let disposed = false;

    const measure = () => {
      if (disposed || footer.getBoundingClientRect().width === 0) return;
      const reasoning = tools.querySelector<HTMLElement>(
        '[data-setting-id="thinking_level"] > button',
      );
      const reference = tools.querySelector<HTMLElement>("[data-composer-reference-trigger]");
      if (!reasoning) {
        footer.removeAttribute("data-reasoning-collapsed");
        footer.removeAttribute("data-reference-collapsed");
        return;
      }
      // Do not remove the user's focus or an open picker's anchor. Its close
      // or focus-out event will re-evaluate the available room.
      if (
        reasoningPickerOpen ||
        reasoning.contains(document.activeElement) ||
        reasoning.dataset.state === "open"
      ) return;

      // Temporarily lay out the full row without wrapping, including a hidden
      // reasoning selector. Restoring this before paint avoids a second copy
      // of the interactive control and gives the same answer in either state.
      footer.setAttribute("data-reasoning-measuring", "");
      let overflow: boolean;
      try {
        footer.removeAttribute("data-reference-collapsed");
        overflow = tools.scrollWidth > tools.clientWidth + 1;
        // Keep the existing reasoning shortcut before the optional reference
        // button. References remain available through @ and Thread actions.
        if (overflow && reference && !reference.contains(document.activeElement)) {
          footer.setAttribute("data-reference-collapsed", "");
          overflow = tools.scrollWidth > tools.clientWidth + 1;
        }
      } finally {
        footer.removeAttribute("data-reasoning-measuring");
      }
      footer.toggleAttribute("data-reasoning-collapsed", overflow);
    };
    const schedule = () => {
      if (!disposed) measure();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(footer);
    resize.observe(tools);
    resize.observe(actions);
    const mutations = new MutationObserver(schedule);
    mutations.observe(footer, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "data-state", "aria-expanded"],
    });
    footer.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    void document.fonts?.ready.then(schedule);
    measureRef.current = measure;
    measure();
    return () => {
      disposed = true;
      measureRef.current = undefined;
      resize.disconnect();
      mutations.disconnect();
      footer.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
      footer.removeAttribute("data-reasoning-measuring");
      footer.removeAttribute("data-reasoning-collapsed");
      footer.removeAttribute("data-reference-collapsed");
    };
  }, [footer, reasoningPickerOpen]);

  return {
    footerRef: setFooter,
    onReasoningPickerOpenChange: setReasoningPickerOpen,
  };
}
