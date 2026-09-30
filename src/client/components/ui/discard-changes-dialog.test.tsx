// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscardChangesDialog } from "./discard-changes-dialog.js";

afterEach(cleanup);

describe("DiscardChangesDialog", () => {
  it("offers Keep editing first, focused, and a destructive discard last", async () => {
    render(
      <DiscardChangesDialog open onOpenChange={vi.fn()} onDiscard={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    expect(dialog).toHaveAccessibleDescription("Your changes have not been saved.");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Keep editing",
      "Discard changes",
    ]);
    expect(screen.getByRole("button", { name: "Discard changes" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus(),
    );
  });

  it("names the follow-up action, discards, then closes", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DiscardChangesDialog
        open
        onOpenChange={onOpenChange}
        description="This workspace has unsaved panel changes."
        discardLabel="Discard and leave"
        onDiscard={onDiscard}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps editing without discarding", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DiscardChangesDialog open onOpenChange={onOpenChange} onDiscard={onDiscard} />,
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
