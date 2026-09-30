import "./settings.css";
import { Check, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@client/components/ui/button";

/** How long "Saved" stays in the bar. */
export const SAVED_NOTICE_MS = 2500;

export type SaveBarProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** The form has unsaved changes; Save and Cancel are enabled only then. */
  readonly dirty: boolean;
  readonly saving?: boolean;
  /**
   * Set after a successful save (a timestamp or counter); each new value
   * shows "Saved" briefly. It gives way as soon as the form is dirty again.
   */
  readonly savedAt?: number;
  /** A save failure, shown in place of the state. */
  readonly error?: React.ReactNode;
  readonly onCancel?: () => void;
  /** Without it, Save submits the enclosing (or `form`) form. */
  readonly onSave?: () => void;
  /** The id of the form Save submits, when the bar sits outside it. */
  readonly form?: string;
  readonly saveLabel?: string;
  readonly savingLabel?: string;
  readonly cancelLabel?: string;
  /** Blocks Save while the form is invalid. */
  readonly saveDisabled?: boolean;
  /**
   * `page` (default) is the sticky, full-bleed footer of the page scroller;
   * `pane` sits at the end of a short editor pane, in flow.
   */
  readonly placement?: "page" | "pane";
};

/**
 * The sticky footer of an editable settings page: the save state on the
 * left, Cancel then Save on the right. It takes its own space in the flow,
 * so it never covers the end of the page.
 */
export function SaveBar({
  dirty,
  saving = false,
  savedAt,
  error,
  onCancel,
  onSave,
  form,
  saveLabel = "Save",
  savingLabel = "Saving…",
  cancelLabel = "Cancel",
  saveDisabled = false,
  placement = "page",
  ...props
}: SaveBarProps): React.JSX.Element {
  const [savedNotice, setSavedNotice] = useState(false);
  useEffect(() => {
    if (savedAt === undefined) return;
    setSavedNotice(true);
    const timer = window.setTimeout(() => setSavedNotice(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  useEffect(() => {
    if (dirty) setSavedNotice(false);
  }, [dirty]);

  const state = error ? "error" : saving ? "saving" : dirty ? "dirty" : savedNotice ? "saved" : "clean";
  return (
    <div data-slot="save-bar" data-state={state} data-placement={placement} {...props}>
      {state === "error" ? (
        <div data-slot="save-bar-status" data-state="error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : (
        <div data-slot="save-bar-status" data-state={state} role="status">
          {state === "dirty" ? <><span data-slot="save-bar-dot" aria-hidden="true" />Unsaved changes</> : null}
          {state === "saving" ? savingLabel : null}
          {state === "saved" ? <><Check aria-hidden="true" />Saved</> : null}
        </div>
      )}
      <div data-slot="save-bar-actions">
        {onCancel ? (
          <Button type="button" variant="outline" disabled={!dirty || saving} onClick={onCancel}>
            {cancelLabel}
          </Button>
        ) : null}
        <Button
          type={onSave ? "button" : "submit"}
          form={onSave ? undefined : form}
          disabled={!dirty || saving || saveDisabled}
          onClick={onSave}
        >
          {saving ? savingLabel : saveLabel}
        </Button>
      </div>
    </div>
  );
}
