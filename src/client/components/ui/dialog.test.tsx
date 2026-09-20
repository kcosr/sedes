// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogFooter } from "./dialog.js";

afterEach(cleanup);

describe("DialogFooter", () => {
  it("renders an unchromed wrapping action row that stays within narrow dialogs", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogFooter>
            <button type="button">Cancel</button>
            <button type="button">Save without applying changes</button>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const footer = screen.getByText("Cancel").parentElement;
    expect(footer).toHaveAttribute("data-slot", "dialog-footer");
    expect(footer).toHaveClass(
      "ml-auto",
      "flex",
      "w-fit",
      "max-w-full",
      "flex-row",
      "flex-wrap",
      "justify-end",
      "gap-2",
    );
    expect(footer).not.toHaveClass(
      "flex-col-reverse",
      "border-t",
      "bg-muted/50",
      "p-4",
      "-mx-4",
      "-mb-4",
    );
  });
});
