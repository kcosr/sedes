import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { matchesTouchDensity } from "../app/use-touch-density.js";

/** Search pickers open for browsing on touch screens; typing is an explicit action. */
export function usePickerFocus(searchRef: RefObject<HTMLInputElement | null>) {
  const modality = useRef<"keyboard" | "touch" | "mouse" | undefined>(undefined);
  const requestSearchFocus = () => { modality.current = "keyboard"; };
  const onPointerDown = (event: PointerEvent) => {
    modality.current = event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : "mouse";
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) requestSearchFocus();
  };
  const focusPicker = (content: HTMLElement | null) => {
    const search = modality.current === "keyboard" ||
      (modality.current !== "touch" && !matchesTouchDensity());
    modality.current = undefined;
    (search ? searchRef.current : content)?.focus({ preventScroll: true });
  };
  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    focusPicker(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  };
  return { onPointerDown, onKeyDown, onOpenAutoFocus, focusPicker, requestSearchFocus };
}
