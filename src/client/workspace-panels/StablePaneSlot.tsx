import { useLayoutEffect, useRef } from "react";

export interface StablePaneSlotProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /**
   * A host created and owned outside the recursive layout tree. Portal
   * content can remain mounted in this element while the slot moves it to a
   * different branch of the rendered layout.
   */
  readonly target: HTMLElement;
}

/**
 * Places a stable portal target at a leaf in the current layout topology.
 *
 * The target is deliberately not created or owned here: this component may
 * unmount when a split is introduced, flattened, or collapsed. Its cleanup
 * removes the target only while this exact slot still owns it, so an old
 * slot cannot detach a target that a newer slot has already adopted.
 */
export function StablePaneSlot({
  target,
  ...attributes
}: StablePaneSlotProps): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.append(target);

    return () => {
      if (target.parentNode === slot) target.remove();
    };
  }, [target]);

  return <div {...attributes} ref={slotRef} />;
}
