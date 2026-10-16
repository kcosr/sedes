// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automationEditPath,
  automationPath,
  automationsPath,
  navigate,
  threadPath,
  threadTurnPath,
} from "../../app/router.js";
import {
  automationEditorUp,
  automationPageUp,
  shownAutomationUp,
  useAutomationUp,
} from "./automation-navigation.js";
import { useAutomationThreadId, usePublishAutomationThread } from "./automation-route-thread.js";

afterEach(() => {
  cleanup();
  navigate("/", { replace: true });
});

const thread = { id: "thread-1", title: "Checkout flow refactor" };

/** History down to `last`, from `entries` (the first replaces the current entry). */
function openFrom(...entries: string[]) {
  entries.forEach((entry, index) => navigate(entry, { replace: index === 0 }));
}

describe("automationPageUp", () => {
  it("names the list history came from: the thread's or every automation's", () => {
    openFrom(automationsPath(thread.id), automationPath("a1"));
    expect(automationPageUp("a1", thread)).toMatchObject({ label: "Automations", href: automationsPath(thread.id) });
    openFrom(automationsPath(), automationPath("a1"));
    expect(automationPageUp("a1", thread)).toMatchObject({ label: "Automations", href: "/automations" });
  });

  it("names the thread history came from, even at a focused turn", () => {
    openFrom(threadTurnPath(thread.id, "turn-1"), automationPath("a1"));
    expect(automationPageUp("a1", thread)).toMatchObject({
      label: thread.title,
      href: threadTurnPath(thread.id, "turn-1"),
    });
  });

  it("looks past the automation's own editor", () => {
    openFrom(threadPath(thread.id), automationPath("a1"), automationEditPath("a1"), automationPath("a1"));
    expect(automationPageUp("a1", thread)).toMatchObject({ label: thread.title });
  });

  it("goes up to the thread's list from anywhere else, or every automation's while the thread is unknown", () => {
    openFrom(threadPath("another-thread"), automationPath("a1"));
    expect(automationPageUp("a1", thread)).toMatchObject({ label: "Automations", href: automationsPath(thread.id) });
    expect(automationPageUp("a1")).toMatchObject({ label: "Automations", href: "/automations" });
    openFrom(threadPath(thread.id), automationPath("a1"));
    expect(automationPageUp("a1")).toMatchObject({ label: "Automations", href: "/automations" });
  });

  it("goes where its label says", async () => {
    openFrom(threadPath(thread.id), automationPath("a1"));
    automationPageUp("a1", thread).go();
    await vi.waitFor(() => expect(window.location.pathname).toBe(threadPath(thread.id)));
    openFrom("/settings/general", automationPath("a1"));
    const length = window.history.length;
    automationPageUp("a1", thread).go();
    expect(window.location.pathname).toBe(automationsPath(thread.id));
    expect(window.history.length).toBe(length);
  });
});

describe("automationEditorUp", () => {
  it("leads a new automation to its thread's list and an automation's edit to its page", () => {
    expect(automationEditorUp(thread.id)).toMatchObject({ label: "Automations", href: automationsPath(thread.id) });
    expect(automationEditorUp(thread.id, { id: "a1", name: "Nightly audit" })).toMatchObject({
      label: "Nightly audit",
      href: automationPath("a1"),
    });
  });
});

describe("useAutomationUp", () => {
  function press(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  it("offers the shown page's way up to Escape and Android Back while mounted", () => {
    const up = vi.fn();
    const hook = renderHook(() => useAutomationUp(up));
    expect(press().defaultPrevented).toBe(true);
    expect(up).toHaveBeenCalledOnce();
    shownAutomationUp()?.();
    expect(up).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(shownAutomationUp()).toBeUndefined();
    expect(press().defaultPrevented).toBe(false);
  });

  it("offers nothing for a page without a way up", () => {
    renderHook(() => useAutomationUp(undefined));
    expect(shownAutomationUp()).toBeUndefined();
    expect(press().defaultPrevented).toBe(false);
  });
});

describe("the automation's thread for the shell", () => {
  it("answers only for the automation published, and keeps it between its page and editor", () => {
    const shell = renderHook(({ id }) => useAutomationThreadId(id), { initialProps: { id: "a1" as string | undefined } });
    const page = renderHook(({ id, threadId }) => usePublishAutomationThread(id, threadId), {
      initialProps: { id: "a1" as string | undefined, threadId: undefined as string | undefined },
    });
    expect(shell.result.current).toBeUndefined();
    page.rerender({ id: "a1", threadId: "thread-1" });
    expect(shell.result.current).toBe("thread-1");
    // The editor of the same automation mounts before its own load.
    page.unmount();
    expect(shell.result.current).toBe("thread-1");
    shell.rerender({ id: "a2" });
    expect(shell.result.current).toBeUndefined();
    shell.rerender({ id: undefined });
    expect(shell.result.current).toBeUndefined();
  });
});
