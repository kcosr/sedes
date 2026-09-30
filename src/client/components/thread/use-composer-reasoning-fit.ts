import { useLayoutEffect, useState } from "react";

/** Reasoning yields to delivery actions, using their actual rendered widths. */
export function useComposerReasoningFit() {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [reasoningPickerOpen, setReasoningPickerOpen] = useState(false);

  useLayoutEffect(() => {
    if (!footer) return;
    const tools = footer.querySelector<HTMLElement>(".composer-tools");
    const actions = footer.querySelector<HTMLElement>(".send-group");
    if (!tools || !actions) return;
    let frame: number | undefined;
    let disposed = false;

    const measure = () => {
      frame = undefined;
      if (disposed || footer.getBoundingClientRect().width === 0) return;
      const reasoning = tools.querySelector<HTMLElement>(
        '[data-setting-id="thinking_level"] > button',
      );
      if (!reasoning) {
        footer.removeAttribute("data-reasoning-collapsed");
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
        overflow = tools.scrollWidth > tools.clientWidth + 1;
      } finally {
        footer.removeAttribute("data-reasoning-measuring");
      }
      footer.toggleAttribute("data-reasoning-collapsed", overflow);
    };
    const schedule = () => {
      if (!disposed && frame === undefined) frame = requestAnimationFrame(measure);
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
    measure();
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      footer.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
      footer.removeAttribute("data-reasoning-measuring");
      footer.removeAttribute("data-reasoning-collapsed");
    };
  }, [footer, reasoningPickerOpen]);

  return {
    footerRef: setFooter,
    onReasoningPickerOpenChange: setReasoningPickerOpen,
  };
}
