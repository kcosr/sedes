import * as React from "react"

import { Button } from "@client/components/ui/button"
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog"
import type { Tone } from "@client/components/ui/tone"

type ConfirmDialogProps = Omit<
  React.ComponentProps<typeof DialogContent>,
  "title" | "children" | "size" | "layout" | "mobile" | "showClose" | "dismissible"
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** The primary action; name the verb and object ("Delete connection"). */
  confirmLabel: string
  /** Shown while `onConfirm` runs; defaults to the confirm label with "…". */
  pendingLabel?: string
  cancelLabel?: string
  /** `danger` makes the confirm solid red; only for irreversible actions. */
  tone?: Extract<Tone, "neutral" | "danger">
  /** Reasons the action cannot run yet; the confirm stays disabled while any remain. */
  blockers?: readonly React.ReactNode[]
  /** Keeps the confirm disabled while a required choice is missing or invalid. */
  confirmDisabled?: boolean
  /** Shown inside the failure alert under its message, such as what blocked the action. */
  errorDetail?: React.ReactNode
  blockersTitle?: React.ReactNode
  /** Extra body content between the description and the footer. */
  children?: React.ReactNode
  /**
   * Runs the action. The dialog closes when it resolves; a rejection keeps
   * it open with the error's message inline.
   */
  onConfirm: () => void | Promise<void>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Something went wrong. Try again."
}

/**
 * The one confirmation dialog: a small card (a centered card on phones too)
 * with no X; Cancel is the way out. Cancel and dismissal lock while the
 * action is pending. Focus opens on the confirm action, or on Cancel when
 * the action is destructive, and returns on close to the element that
 * opened the dialog. When the action removes that element (deleting the
 * row), pass `fallbackFocus` to name a surviving neighbour.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "neutral",
  blockers = [],
  blockersTitle = "Resolve these first",
  confirmDisabled = false,
  errorDetail,
  children,
  onConfirm,
  ...contentProps
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const blocked = blockers.length > 0

  React.useEffect(() => {
    if (!open) setError(undefined)
  }, [open])

  const confirm = async () => {
    if (pending || blocked || confirmDisabled) return
    setPending(true)
    setError(undefined)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <DialogContent
        size="sm"
        showClose={false}
        dismissible={!pending}
        aria-busy={pending || undefined}
        {...(description === undefined ? { "aria-describedby": undefined } : {})}
        {...contentProps}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {(children !== undefined || blocked || error !== undefined) && (
          <DialogBody>
            {children}
            {blocked && (
              <DialogAlert tone="warning" title={blockersTitle}>
                <ul className="m-0 grid list-disc gap-0.5 pl-4">
                  {blockers.map((blocker, index) => (
                    <li key={index}>{blocker}</li>
                  ))}
                </ul>
              </DialogAlert>
            )}
            {error !== undefined && (
              <DialogAlert tone="danger">
                {error}
                {errorDetail}
              </DialogAlert>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "destructive" : "default"}
            disabled={pending || blocked || confirmDisabled}
            onClick={() => void confirm()}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
export type { ConfirmDialogProps }
