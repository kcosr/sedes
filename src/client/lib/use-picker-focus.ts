import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

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
    const mobile = typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse), (max-width: 819px)").matches;
    const search = modality.current === "keyboard" || (modality.current !== "touch" && !mobile);
    modality.current = undefined;
    (search ? searchRef.current : content)?.focus({ preventScroll: true });
  };
  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    focusPicker(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  };
  return { onPointerDown, onKeyDown, onOpenAutoFocus, focusPicker, requestSearchFocus };
}
