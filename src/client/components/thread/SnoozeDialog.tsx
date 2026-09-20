import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@client/components/ui/button";

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
  /**
   * Radix returns dialog focus to `Dialog.Trigger`; this dialog is controlled
   * (opened from a menu row that unmounts with its menu), so without an
   * explicit target closing drops focus to `<body>`.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [snoozeUntil, setSnoozeUntil] = useState(() =>
    localDateTime(new Date(Date.now() + 3_600_000)),
  );
  const [wakeReminder, setWakeReminder] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

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
    setPending(true);
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
      setPending(false);
    }
  };

  const remindNow = async () => {
    const reminder = wakeReminder.trim();
    if (!reminder) return;
    setPending(true);
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
      setPending(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError("");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay over-drawer"
          data-testid="dialog-overlay"
        />
        <Dialog.Content
          className="dialog-card over-drawer"
          aria-describedby="snooze-description"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Dialog.Title>Snooze this thread</Dialog.Title>
          <Dialog.Description id="snooze-description">
            Choose when this thread returns to Active, or show its reminder now
            without snoozing.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dialog-close"
              aria-label="Close"
            >
              <X size={18} strokeWidth={1.8} />
            </Button>
          </Dialog.Close>
          <label className="field">
            <span>Wake date and time</span>
            <input
              type="datetime-local"
              min={localDateTime(new Date(Date.now() + 60_000))}
              value={snoozeUntil}
              onChange={(event) => setSnoozeUntil(event.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Reminder <small>Optional when snoozing</small>
            </span>
            <textarea
              className="snooze-reminder-input"
              maxLength={1_000}
              value={wakeReminder}
              placeholder="What should I remember when I return?"
              onChange={(event) => setWakeReminder(event.target.value)}
            />
            <small>{wakeReminder.length.toLocaleString()} / 1,000</small>
          </label>
          <div className="preset-row">
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
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button
              variant="outline"
              disabled={pending || !wakeReminder.trim()}
              onClick={() => void remindNow()}
            >
              Remind now
            </Button>
            <Button disabled={pending} onClick={() => void snooze()}>
              {pending ? "Snoozing…" : "Snooze"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
