import { CircleAlert } from "lucide-react";

/**
 * A field error in the Field primitive's style, for automation controls that
 * their section names (the section label is their visible label).
 */
export function AutomationFieldError({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p id={id} className="automation-field-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
