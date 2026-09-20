// @vitest-environment jsdom

import { createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnoozeDialog } from "./SnoozeDialog.js";

afterEach(cleanup);

describe("SnoozeDialog", () => {
  it("validates the deadline and submits a trimmed optional reminder", async () => {
    const onSnooze = vi.fn().mockResolvedValue(undefined);
    const onRemindNow = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <SnoozeDialog
        open
        onOpenChange={onOpenChange}
        onSnooze={onSnooze}
        onRemindNow={onRemindNow}
      />,
    );

    fireEvent.change(screen.getByLabelText("Wake date and time"), {
      target: { value: "2020-01-01T00:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Snooze$/ }));
    expect(
      await screen.findByText("Choose a snooze time in the future."),
    ).toBeVisible();
    expect(onSnooze).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    fireEvent.change(screen.getByLabelText(/Reminder/), {
      target: { value: "  Review the result  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Snooze$/ }));

    expect(onSnooze).toHaveBeenCalledWith({
      snoozedUntil: expect.stringMatching(/Z$/),
      wakeReminder: "Review the result",
    });
  });

  it("shows a trimmed reminder now without submitting a snooze", async () => {
    const onSnooze = vi.fn().mockResolvedValue(undefined);
    const onRemindNow = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <SnoozeDialog
        open
        onOpenChange={onOpenChange}
        onSnooze={onSnooze}
        onRemindNow={onRemindNow}
      />,
    );

    const remindNow = screen.getByRole("button", { name: "Remind now" });
    expect(remindNow).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reminder/), {
      target: { value: "  Review the result  " },
    });
    fireEvent.click(remindNow);

    await waitFor(() => expect(onRemindNow).toHaveBeenCalledWith("Review the result"));
    expect(onSnooze).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open and reports a failed mutation", async () => {
    const onSnooze = vi.fn().mockRejectedValue(new Error("Revision conflict"));
    render(
      <SnoozeDialog
        open
        onOpenChange={vi.fn()}
        onSnooze={onSnooze}
        onRemindNow={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Snooze$/ }));
    expect(await screen.findByText("Revision conflict")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  // Radix hands dialog focus back to `Dialog.Trigger`; this dialog is opened
  // from a menu row that unmounts with its menu, so without the explicit
  // target closing would drop focus to <body>.
  it("returns focus to the control the caller named", async () => {
    const trigger = createRef<HTMLButtonElement>();
    const dialog = (open: boolean) => (
      <>
        <button ref={trigger} type="button">
          Thread actions
        </button>
        <SnoozeDialog
          open={open}
          onOpenChange={vi.fn()}
          onSnooze={vi.fn().mockResolvedValue(undefined)}
          onRemindNow={vi.fn().mockResolvedValue(undefined)}
          returnFocusRef={trigger}
        />
      </>
    );
    const view = render(dialog(true));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(dialog(false));
    await waitFor(() => expect(trigger.current).toHaveFocus());
  });
});
