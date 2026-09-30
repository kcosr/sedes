// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionWorkspaceDeleteDialog,
  ExecutionWorkspaceGitWarnings,
} from "./ExecutionWorkspaceActions.js";

afterEach(cleanup);

describe("ExecutionWorkspaceActions", () => {
  it("returns focus to the owning surface after deletion is cancelled", async () => {
    function DeleteDialogHarness() {
      const [open, setOpen] = useState(true);
      const returnFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={returnFocusRef}>Thread actions</button>
          <ExecutionWorkspaceDeleteDialog
            workspace={{
              kind: "isolated",
              workspaceAccess: "writable_clone",
              state: "ready",
              allocationRevision: 1,
              networkProfile: "isolated",
              hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
              branch: "sedes/thread-1",
              gitStatus: { available: false, reason: "not inspected" },
            }}
            open={open}
            onOpenChange={setOpen}
            pending={false}
            onDelete={() => undefined}
            returnFocusRef={returnFocusRef}
          />
        </>
      );
    }

    render(<DeleteDialogHarness />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Thread actions" }),
      ).toHaveFocus(),
    );
  });

  it("never presents a clean no-upstream branch as verified safe to delete", () => {
    render(
      <ExecutionWorkspaceGitWarnings
        workspace={{
          kind: "isolated",
          workspaceAccess: "writable_clone",
          state: "ready",
          allocationRevision: 1,
          networkProfile: "isolated",
          hostPaths: { home: "/sandbox", workspace: "/sandbox/repo" },
          branch: "sedes/thread-1",
          gitStatus: {
            available: true,
            trackedChangeCount: 0,
            untrackedFileCount: 0,
            upstream: null,
            aheadCount: null,
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "No upstream is configured; unpushed work cannot be verified.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Git reports no local or unpushed work."),
    ).not.toBeInTheDocument();
  });
});
