// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog.js";

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function Harness(props: Partial<React.ComponentProps<typeof ConfirmDialog>> & {
  readonly onConfirm: () => void | Promise<void>;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      title="Remove environment “Build server”?"
      description="Its 2 backends are removed too. This can’t be undone."
      confirmLabel="Remove environment"
      pendingLabel="Removing…"
      {...props}
      open={open}
      onOpenChange={(next) => {
        props.onOpenChange?.(next);
        setOpen(next);
      }}
    />
  );
}

describe("ConfirmDialog", () => {
  it("shows the title and description with Cancel then the primary action last, and no X", () => {
    render(<Harness onConfirm={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Remove environment “Build server”?" });
    expect(dialog).toHaveAccessibleDescription("Its 2 backends are removed too. This can’t be undone.");
    expect(dialog).toHaveAttribute("data-size", "sm");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Remove environment",
    ]);
  });

  it("focuses the confirm action by default and Cancel when destructive", async () => {
    const { unmount } = render(<Harness onConfirm={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove environment" })).toHaveFocus());
    unmount();
    render(<Harness tone="danger" onConfirm={vi.fn()} />);
    const confirm = screen.getByRole("button", { name: "Remove environment" });
    expect(confirm).toHaveAttribute("data-variant", "destructive");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("locks the dialog while the action runs and closes when it resolves", async () => {
    const user = userEvent.setup();
    const action = deferred();
    const onOpenChange = vi.fn();
    render(<Harness onConfirm={() => action.promise} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Remove environment" }));
    const pending = screen.getByRole("button", { name: "Removing…" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("dialog-overlay"));
    expect(onOpenChange).not.toHaveBeenCalled();
    action.resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open with the error inline when the action fails", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error("The environment has running threads."))
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(<Harness tone="danger" onConfirm={onConfirm} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Remove environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The environment has running threads.");
    expect(onOpenChange).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Remove environment" });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false));
  });

  it("uses a default pending label that ends in an ellipsis", async () => {
    const user = userEvent.setup();
    const action = deferred();
    render(<Harness pendingLabel={undefined} confirmLabel="Discard changes" onConfirm={() => action.promise} />);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("button", { name: "Discard changes…" })).toBeDisabled();
    action.resolve();
  });

  it("lists blockers and keeps the action disabled while any remain", async () => {
    const onConfirm = vi.fn();
    render(
      <Harness
        onConfirm={onConfirm}
        blockers={["2 threads are running on this environment.", "A backend is still connecting."]}
      />,
    );
    expect(screen.getByText("Resolve these first")).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "2 threads are running on this environment.",
      "A backend is still connecting.",
    ]);
    const confirm = screen.getByRole("button", { name: "Remove environment" });
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("cancels without running the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<Harness onConfirm={onConfirm} onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  describe("focus on close", () => {
    // A list whose rows open the confirm from their Delete buttons (no
    // DialogTrigger); confirming removes the row, and with it the opener.
    function RowList({ keep = false }: { readonly keep?: boolean }) {
      const [rows, setRows] = useState(["Alpha", "Beta", "Gamma"]);
      const [deleting, setDeleting] = useState<string>();
      const removedIndex = useRef(0);
      const list = useRef<HTMLUListElement>(null);
      return (
        <>
          <ul ref={list}>
            {rows.map((row) => (
              <li key={row}>
                <button type="button" onClick={() => setDeleting(row)}>
                  Delete {row}
                </button>
              </li>
            ))}
          </ul>
          <ConfirmDialog
            open={deleting !== undefined}
            onOpenChange={(open) => {
              if (!open) setDeleting(undefined);
            }}
            tone="danger"
            title={`Delete ${deleting ?? ""}?`}
            confirmLabel="Delete"
            fallbackFocus={() => {
              const buttons = list.current?.querySelectorAll("button") ?? [];
              return buttons[Math.min(removedIndex.current, buttons.length - 1)];
            }}
            onConfirm={() => {
              if (keep) return;
              removedIndex.current = rows.indexOf(deleting!);
              setRows((current) => current.filter((row) => row !== deleting));
            }}
          />
        </>
      );
    }

    it.each([
      ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole("button", { name: "Cancel" }));
      }],
      ["Escape", async (user: ReturnType<typeof userEvent.setup>) => {
        await user.keyboard("{Escape}");
      }],
    ])("returns focus to the invoking button after %s", async (_, dismiss) => {
      const user = userEvent.setup();
      render(<RowList />);
      const invoker = screen.getByRole("button", { name: "Delete Beta" });
      await user.click(invoker);
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
      await dismiss(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(invoker).toHaveFocus());
    });

    it("focuses the next row after the action removed the invoking one", async () => {
      const user = userEvent.setup();
      render(<RowList />);
      await user.click(screen.getByRole("button", { name: "Delete Beta" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.queryByRole("button", { name: "Delete Beta" })).toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: "Delete Gamma" })).toHaveFocus());
    });

    it("focuses the new last row after the last one is removed", async () => {
      const user = userEvent.setup();
      render(<RowList />);
      await user.click(screen.getByRole("button", { name: "Delete Gamma" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Delete Beta" })).toHaveFocus());
    });

    it("returns focus to the invoker when a confirmed action keeps it", async () => {
      const user = userEvent.setup();
      render(<RowList keep />);
      const invoker = screen.getByRole("button", { name: "Delete Alpha" });
      await user.click(invoker);
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(invoker).toHaveFocus());
    });
  });
});
