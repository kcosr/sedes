import * as React from "react"

import {
  ConfirmDialog,
  type ConfirmDialogProps,
} from "@client/components/ui/confirm-dialog"

type DiscardChangesDialogProps = Omit<
  ConfirmDialogProps,
  "title" | "description" | "confirmLabel" | "pendingLabel" | "cancelLabel" | "tone" | "onConfirm"
> & {
  /** Defaults to "Discard unsaved changes?". */
  title?: React.ReactNode
  /** What is unsaved and what happens next; defaults to a generic sentence. */
  description?: React.ReactNode
  /** Names what follows the discard: "Discard and leave", "Discard and close". */
  discardLabel?: string
  /** Discards and continues; a rejection keeps the dialog open with the error. */
  onDiscard: () => void | Promise<void>
}

/**
 * The one "discard unsaved changes" guard: a ConfirmDialog with "Keep
 * editing" as the way back (and the initial focus) and a solid destructive
 * discard, since the edits cannot be recovered.
 */
function DiscardChangesDialog({
  title = "Discard unsaved changes?",
  description = "Your changes have not been saved.",
  discardLabel = "Discard changes",
  onDiscard,
  ...props
}: DiscardChangesDialogProps) {
  return (
    <ConfirmDialog
      title={title}
      description={description}
      confirmLabel={discardLabel}
      cancelLabel="Keep editing"
      tone="danger"
      onConfirm={onDiscard}
      {...props}
    />
  )
}

export { DiscardChangesDialog }
export type { DiscardChangesDialogProps }
