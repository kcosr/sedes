import { cx } from "../lib/cx";
import { Icon } from "./Icon";

/** Rotating refresh icon. With `label` it is announced (role=status); otherwise decorative. */
export function Spinner({
  label,
  className,
}: {
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx("wb-spinner", className)}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon name="refresh" />
    </span>
  );
}
