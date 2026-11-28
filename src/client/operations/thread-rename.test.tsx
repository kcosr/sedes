// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { ThreadRenameEditor, useThreadRename } from "./thread-rename.js";

afterEach(cleanup);

const initial = {
  id: "target",
  title: { text: "Original" },
  threadRevision: 2,
};
const latest = {
  ...initial,
  title: { text: "Concurrent title" },
  threadRevision: 9,
};
function fixture() {
  const renameThread = vi
    .fn<ApplicationClientStore["renameThread"]>()
    .mockImplementation(async (_id, _title, _revision, mutationId) => ({
      status: "accepted",
      operationId: mutationId,
    }));
  return {
    store: { renameThread } as unknown as ApplicationClientStore,
    renameThread,
  };
}
function Editor({
  thread = initial,
  store,
  surface = "sidebar",
}: {
  thread?: Pick<
    NormalizedApplicationThreadSummary,
    "id" | "title" | "threadRevision"
  >;
  store: ApplicationClientStore;
  surface?: string;
}) {
  const rename = useThreadRename(store, thread, surface);
  return rename.edit ? (
    <ThreadRenameEditor
      rename={rename}
      className="editor"
      onKeyboardFinish={() => undefined}
    />
  ) : (
    <button onClick={rename.begin}>Rename {surface}</button>
  );
}
function input() {
  return screen.getByRole("textbox", { name: "Thread title" });
}
function submit() {
  fireEvent.submit(input().closest("form")!);
}

describe("thread rename outcomes", () => {
  it.each(["recovery", "different operation", "lost reply"])(
    "keeps the edit-start revision, coalesces Enter/blur and checks the same request after %s and remount",
    async (failure) => {
      const { store, renameThread } = fixture();
      let settle!: () => void;
      renameThread.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        if (failure === "lost reply") throw new TypeError("Failed to fetch");
        if (failure === "recovery")
          return {
            status: "recovery_required",
            retryable: true,
            diagnostic: "Recheck",
          };
        return { status: "accepted", operationId: "another-operation" };
      });
      const view = render(<Editor store={store} />);
      fireEvent.click(screen.getByText("Rename sidebar"));
      fireEvent.change(input(), { target: { value: "Proposal" } });
      view.rerender(<Editor store={store} thread={latest} />);
      submit();
      fireEvent.blur(input());
      submit();
      expect(input()).toHaveAttribute("readonly");
      expect(renameThread).toHaveBeenCalledExactlyOnceWith(
        initial.id,
        "Proposal",
        2,
        expect.any(String),
      );
      view.unmount();
      settle();
      render(<Editor store={store} thread={latest} surface="header" />);
      fireEvent.click(screen.getByText("Rename header"));
      const check = await screen.findByRole("button", {
        name: "Check rename status",
      });
      expect(input()).toHaveValue("Proposal");
      fireEvent.click(check);
      await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
      expect(renameThread.mock.calls).toHaveLength(2);
      expect(renameThread.mock.calls[1]).toEqual(renameThread.mock.calls[0]);
    },
  );

  it("requires an explicit new edit after a rejection and submits against the displayed current revision", async () => {
    const { store, renameThread } = fixture();
    renameThread.mockRejectedValueOnce(
      new ApiError(409, "conflict", "Title changed.", false),
    );
    const view = render(<Editor store={store} />);
    fireEvent.click(screen.getByText("Rename sidebar"));
    fireEvent.change(input(), { target: { value: "Proposal" } });
    view.rerender(<Editor store={store} thread={latest} />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Current title: Concurrent title",
    );
    expect(input()).toHaveValue("Proposal");
    expect(input()).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Edit again" }));
    expect(input()).not.toHaveAttribute("readonly");
    submit();
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(renameThread.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [initial.id, "Proposal", 2],
      [initial.id, "Proposal", 9],
    ]);
    expect(renameThread.mock.calls[1]![3]).not.toBe(
      renameThread.mock.calls[0]![3],
    );
  });

  it("isolates an unresolved title from a second connection with the same thread id", async () => {
    const first = fixture();
    const second = fixture();
    first.renameThread.mockRejectedValueOnce(new TypeError("Connection lost"));
    const view = render(<Editor store={first.store} />);
    fireEvent.click(screen.getByText("Rename sidebar"));
    fireEvent.change(input(), {
      target: { value: "Pending on first connection" },
    });
    submit();
    await screen.findByRole("alert");
    view.rerender(<Editor store={second.store} />);
    fireEvent.click(screen.getByText("Rename sidebar"));
    expect(input()).toHaveValue(initial.title.text);
    expect(input()).not.toHaveAttribute("readonly");
  });
});
