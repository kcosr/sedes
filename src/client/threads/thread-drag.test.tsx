// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationSnapshot, NormalizedApplicationThreadSummary } from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { ApiError } from "../api/ApiClient.js";
import { THREAD_DRAG_MIME, ThreadDragProvider, useThreadDrag } from "./thread-drag.js";

const source = { id: "source", title: { text: "Source" }, groupId: null, groupAssignmentRevision: 2 } as NormalizedApplicationThreadSummary;
const target = { id: "target", title: { text: "Target title" }, groupId: null, groupAssignmentRevision: 4 } as NormalizedApplicationThreadSummary;

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    effectAllowed: "none", dropEffect: "none", types,
    setData(type: string, value: string) { values.set(type, value); if (!types.includes(type)) types.push(type); },
    getData(type: string) { return values.get(type) ?? ""; },
  } as unknown as DataTransfer;
}

function Surfaces() {
  const drag = useThreadDrag();
  return <>
    <button draggable onDragStart={(event) => drag?.beginThreadDrag(source.id, event.dataTransfer)} onDragEnd={() => drag?.endThreadDrag()}>Drag source</button>
    <div data-testid="target" data-thread-id={target.id} data-thread-drop-kind="thread"><button>Target</button></div>
    <div data-testid="group" data-thread-drop-kind="group" data-group-id="group-1" />
    <div data-testid="project" data-thread-id={target.id} data-project-id="project-1" />
    <div data-testid="self" data-thread-drop-kind="thread" data-thread-id={source.id} />
    <output>{drag?.activeThreadId ?? "idle"}</output>
  </>;
}

function setup(threads: NormalizedApplicationThreadSummary[] = [source, target]) {
  const snapshot = { threads, groups: [{ id: "group-1", name: "Existing", revision: 0, memberCount: 1, activeMemberCount: 1 }] } as unknown as NormalizedApplicationSnapshot;
  const state = { snapshot, descendantPages: {} };
  const assignThreadGroup = vi.fn().mockResolvedValue(undefined);
  const createThreadGroup = vi.fn().mockResolvedValue(undefined);
  const store = { getSnapshot: () => state, assignThreadGroup, createThreadGroup } as unknown as ApplicationClientStore;
  render(<ThreadDragProvider store={store} snapshot={snapshot}><Surfaces /></ThreadDragProvider>);
  const start = () => {
    const transfer = dataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag source" }), { dataTransfer: transfer });
    return transfer;
  };
  return { state, assignThreadGroup, createThreadGroup, start };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.assign(HTMLElement.prototype, { scrollIntoView: vi.fn(), hasPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("thread grouping drag", () => {
  it("moves one thread onto an existing group and clears the drop highlight", async () => {
    const { start, assignThreadGroup, createThreadGroup } = setup();
    const transfer = start();
    const group = screen.getByTestId("group");
    fireEvent.dragOver(group, { dataTransfer: transfer });
    expect(group).toHaveAttribute("data-thread-drop-target", "true");
    fireEvent.drop(group, { dataTransfer: transfer });
    await waitFor(() => expect(assignThreadGroup).toHaveBeenCalledExactlyOnceWith(source, "group-1", expect.any(String)));
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(group).not.toHaveAttribute("data-thread-drop-target");
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it.each([
    new ApiError(409, "group_assignment_revision_conflict", "The thread group changed in another client.", false),
    new Error("The connection was lost."),
  ])("shows a dismissible alert without taking focus when grouping fails: %s", async (failure) => {
    const { start, assignThreadGroup } = setup();
    assignThreadGroup.mockRejectedValueOnce(failure);
    const focused = screen.getByRole("button", { name: "Target" });
    focused.focus();
    fireEvent.drop(screen.getByTestId("group"), { dataTransfer: start() });
    const alert = await screen.findByRole("alert", { name: "Thread drop failed" });
    expect(alert).toHaveTextContent(failure.message);
    expect(alert).toBeVisible();
    expect(alert.parentElement).toBe(document.body);
    expect(focused).toHaveFocus();
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("joins the target row's current group even when it changed during the drag", async () => {
    const { state, start, assignThreadGroup } = setup();
    const transfer = start();
    state.snapshot = { ...state.snapshot, threads: [source, { ...target, groupId: "group-1", groupAssignmentRevision: 5 }] };
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: transfer });
    await waitFor(() => expect(assignThreadGroup).toHaveBeenCalledWith(source, "group-1", expect.any(String)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prefills a new group from the target and submits both members in one operation", async () => {
    const { start, createThreadGroup, assignThreadGroup } = setup();
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: start() });
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    expect(within(dialog).getByRole("textbox", { name: "Group name" })).toHaveValue("Target title");
    expect(within(dialog).getByText("Creates a group with these 2 threads in it.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createThreadGroup).toHaveBeenCalledExactlyOnceWith([target, source], "Target title", expect.any(String)));
    expect(assignThreadGroup).not.toHaveBeenCalled();
  });

  it("does not mutate when creating a group is cancelled", async () => {
    const { start, createThreadGroup, assignThreadGroup } = setup();
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: start() });
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(assignThreadGroup).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Connection lost"),
    new ApiError(503, "unavailable", "Connection lost", true),
  ])("retains a create mutation id after an ambiguous failure: %s", async (error) => {
    const { start, createThreadGroup } = setup();
    createThreadGroup.mockRejectedValueOnce(error);
    fireEvent.drop(screen.getByTestId("target"), { dataTransfer: start() });
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByText("Connection lost");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createThreadGroup).toHaveBeenCalledTimes(2));
    expect(createThreadGroup.mock.calls[0]).toEqual(createThreadGroup.mock.calls[1]);
  });

  it("ignores same-thread, same-group, and project-stack drops", async () => {
    const { start, assignThreadGroup, createThreadGroup } = setup([{ ...source, groupId: "group-1" }, target]);
    for (const testId of ["self", "group", "project"]) {
      const transfer = start();
      fireEvent.drop(screen.getByTestId(testId), { dataTransfer: transfer });
      fireEvent.dragEnd(screen.getByRole("button", { name: "Drag source" }), { dataTransfer: transfer });
    }
    expect(assignThreadGroup).not.toHaveBeenCalled();
    expect(createThreadGroup).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores external and task payloads, and rejects tampered or removed sources", () => {
    const { start, state, assignThreadGroup, createThreadGroup } = setup();
    const external = dataTransfer();
    external.setData(THREAD_DRAG_MIME, JSON.stringify({ version: 1, threadId: source.id, token: "foreign" }));
    fireEvent.drop(screen.getByTestId("group"), { dataTransfer: external });
    const tampered = start();
    tampered.setData(THREAD_DRAG_MIME, JSON.stringify({ version: 1, threadId: target.id, token: "foreign" }));
    fireEvent.drop(screen.getByTestId("group"), { dataTransfer: tampered });
    const removed = start();
    state.snapshot = { ...state.snapshot, threads: [target] };
    fireEvent.drop(screen.getByTestId("group"), { dataTransfer: removed });
    const task = dataTransfer();
    task.setData("application/x-sedes-task+json", "{}");
    fireEvent.drop(screen.getByTestId("group"), { dataTransfer: task });
    expect(assignThreadGroup).not.toHaveBeenCalled();
    expect(createThreadGroup).not.toHaveBeenCalled();
  });
});
