import { useEffect, useState } from "react";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";

export function SnoozeDialog({
  open,
  onOpenChange,
  onSnooze,
  onRemindNow,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (input: {
    snoozedUntil: string;
    wakeReminder?: string;
  }) => Promise<void>;
  onRemindNow: (wakeReminder: string) => Promise<void>;
  /** Focus target on close; the opening menu row unmounts with its menu. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [snoozeUntil, setSnoozeUntil] = useState(() =>
    localDateTime(new Date(Date.now() + 3_600_000)),
  );
  const [wakeReminder, setWakeReminder] = useState("");
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<"snooze" | "remind">();
  const pending = pendingAction !== undefined;

  useEffect(() => {
    if (!open) return;
    setSnoozeUntil(localDateTime(new Date(Date.now() + 3_600_000)));
  }, [open]);

  const snooze = async () => {
    const date = new Date(snoozeUntil);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      setError("Choose a snooze time in the future.");
      return;
    }
    setPendingAction("snooze");
    setError("");
    try {
      await onSnooze({
        snoozedUntil: date.toISOString(),
        ...(wakeReminder.trim() ? { wakeReminder: wakeReminder.trim() } : {}),
      });
      setWakeReminder("");
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The thread could not be snoozed.",
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  const remindNow = async () => {
    const reminder = wakeReminder.trim();
    if (!reminder) return;
    setPendingAction("remind");
    setError("");
    try {
      await onRemindNow(reminder);
      setWakeReminder("");
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The reminder could not be added.",
      );
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) setError("");
      }}
    >
      <DialogContent
        size="md"
        layer="over-dialog"
        dismissible={!pending}
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>Snooze this thread</DialogTitle>
          <DialogDescription>
            Choose when this thread returns to Active, or show its reminder now
            without snoozing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid gap-2">
            <Field label="Wake date and time">
              <Input
                type="datetime-local"
                min={localDateTime(new Date(Date.now() + 60_000))}
                value={snoozeUntil}
                onChange={(event) => setSnoozeUntil(event.target.value)}
              />
            </Field>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Quick picks"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() =>
                  setSnoozeUntil(
                    localDateTime(new Date(Date.now() + 3_600_000)),
                  )
                }
              >
                1 hour
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => setSnoozeUntil(localDateTime(tomorrowMorning()))}
              >
                Tomorrow
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => setSnoozeUntil(localDateTime(nextWeek()))}
              >
                Next week
              </Button>
            </div>
          </div>
          <Field
            label={
              <>
                Reminder
                <span className="font-normal text-(length:--text-meta) text-muted-foreground-2">
                  Optional when snoozing
                </span>
              </>
            }
          >
            <Textarea
              className="min-h-22 resize-y"
              maxLength={1_000}
              value={wakeReminder}
              placeholder="What should I remember when I return?"
              onChange={(event) => setWakeReminder(event.target.value)}
            />
            <span className="justify-self-end text-(length:--text-label) text-muted-foreground-2 tabular-nums">
              {wakeReminder.length.toLocaleString()} / 1,000
            </span>
          </Field>
          {error && <DialogAlert tone="danger">{error}</DialogAlert>}
        </DialogBody>
        <DialogFooter
          start={
            <Button
              type="button"
              variant="outline"
              disabled={pending || !wakeReminder.trim()}
              onClick={() => void remindNow()}
            >
              {pendingAction === "remind" ? "Adding reminder…" : "Remind now"}
            </Button>
          }
        >
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
              setError("");
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => void snooze()}
          >
            {pendingAction === "snooze" ? "Snoozing…" : "Snooze"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function tomorrowMorning(): Date {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  return value;
}

function nextWeek(): Date {
  const value = tomorrowMorning();
  value.setDate(value.getDate() + 6);
  return value;
}
