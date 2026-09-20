// @vitest-environment jsdom

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentPath,
  agentsPath,
  installNavigationBlocker,
  navigate,
  newAgentPath,
  parseRoute,
  routePath,
  sameRoute,
  settingsPath,
  pushHistoryEntry,
  replaceHistoryEntry,
  type NavigationBlocker,
  threadAutomationPath,
  threadPath,
  threadTurnPath,
} from "./router";
import { clearDiagnostics, readDiagnostics } from "./diagnostics.js";
import { setDiagnosticCategoryEnabled } from "./settings.js";
import { resetThreadLoadAttemptsForTests } from "./thread-load-diagnostics.js";

afterEach(() => {
  navigate("/", { replace: true });
  clearDiagnostics();
  resetThreadLoadAttemptsForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("thread load diagnostics", () => {
  it("starts at accepted navigation before the route is published", () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});

    navigate(threadPath("private-thread-id"));

    expect(readDiagnostics()).toEqual([
      expect.objectContaining({
        category: "thread_load",
        event: "thread_open_requested",
        details: expect.objectContaining({
          attemptId: "load-1",
          source: "navigation",
        }),
      }),
    ]);
    expect(JSON.stringify(readDiagnostics())).not.toContain(
      "private-thread-id",
    );
  });
});

describe("automation routes", () => {
  it("keeps thread conversation and automation settings routes distinct", () => {
    const threadId = randomUUID();

    expect(parseRoute(threadAutomationPath(threadId))).toEqual({
      name: "thread",
      threadId,
      automationOpen: true,
    });
    expect(parseRoute(threadPath(threadId))).toEqual({
      name: "thread",
      threadId,
      automationOpen: false,
    });
  });

  it("keeps normalized source-turn focus in the URL fragment", () => {
    const threadId = randomUUID();
    const turnId = "turn/with spaces";
    expect(threadTurnPath(threadId, turnId)).toBe(
      `/threads/${threadId}#turn=turn%2Fwith%20spaces`,
    );
    expect(parseRoute(threadPath(threadId), "#turn=turn%2Fwith%20spaces")).toEqual({
      name: "thread",
      threadId,
      automationOpen: false,
      focusTurnId: turnId,
    });
    expect(parseRoute(threadPath(threadId), "#turn=%E0%A4%A")).toEqual({
      name: "thread",
      threadId,
      automationOpen: false,
    });
  });

  it("falls home for malformed or partial paths", () => {
    expect(parseRoute("/automations")).toEqual({ name: "home" });
    expect(parseRoute("/threads/id/automation/extra")).toEqual({
      name: "home",
    });
    expect(parseRoute("/threads/%E0%A4%A/automation")).toEqual({ name: "home" });
    expect(parseRoute("/agents/one/extra")).toEqual({ name: "home" });
    expect(parseRoute("/agents/%E0%A4%A")).toEqual({ name: "home" });
  });
});

describe("routePath", () => {
  it("round-trips the routes navigate understands", () => {
    expect(routePath({ name: "home" })).toBe("/");
    expect(routePath({ name: "archived" })).toBe("/archived");
    expect(routePath({ name: "agents", create: false })).toBe(agentsPath());
    expect(routePath({ name: "agents", create: true })).toBe(newAgentPath());
    expect(
      routePath({ name: "agents", agentId: "agent/one", create: false }),
    ).toBe(agentPath("agent/one"));
    expect(parseRoute(agentPath("agent/one"))).toEqual({
      name: "agents",
      agentId: "agent/one",
      create: false,
    });
    expect(
      routePath({ name: "thread", threadId: "t1", automationOpen: false }),
    ).toBe(threadPath("t1"));
    expect(
      routePath({ name: "thread", threadId: "t1", automationOpen: true }),
    ).toBe(threadAutomationPath("t1"));
    expect(
      routePath({
        name: "thread",
        threadId: "t1",
        automationOpen: false,
        focusTurnId: "turn/1",
      }),
    ).toBe(threadTurnPath("t1", "turn/1"));
    expect(
      sameRoute(
        { name: "thread", threadId: "t1", automationOpen: false },
        parseRoute(threadPath("t1")),
      ),
    ).toBe(true);
  });
});

describe("navigation blockers", () => {
  it("allows same-workspace routes while cancel truly prevents a cross-workspace navigation", () => {
    const workspaceByThread = new Map([
      ["thread-a", "workspace-1"],
      ["thread-b", "workspace-1"],
      ["thread-c", "workspace-2"],
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    navigate(threadPath("thread-a"), { replace: true });
    const remove = installNavigationBlocker((current, next) => {
      const currentWorkspace =
        current.name === "thread" ? workspaceByThread.get(current.threadId) : undefined;
      const nextWorkspace =
        next.name === "thread" ? workspaceByThread.get(next.threadId) : undefined;
      return !currentWorkspace || !nextWorkspace || currentWorkspace === nextWorkspace
        ? true
        : window.confirm("discard");
    });
    try {
      navigate(threadPath("thread-b"));
      expect(window.location.pathname).toBe(threadPath("thread-b"));
      expect(confirm).not.toHaveBeenCalled();

      navigate(threadPath("thread-c"));
      expect(window.location.pathname).toBe(threadPath("thread-b"));
      expect(confirm).toHaveBeenCalledOnce();

      confirm.mockReturnValue(true);
      navigate(threadPath("thread-c"));
      expect(window.location.pathname).toBe(threadPath("thread-c"));
    } finally {
      remove();
    }
  });
});


describe("settings routes", () => {
  it("round-trips settings home and each canonical category", () => {
    expect(settingsPath()).toBe("/settings");
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
    expect(routePath({ name: "settings" })).toBe("/settings");
    for (const [page, slug] of [
      ["paired_clients", "paired-clients"], ["notifications", "notifications"],
      ["general", "general"], ["diagnostics", "diagnostics"], ["appearance", "appearance"], ["prompts", "prompts"],
      ["mobile", "mobile"], ["terminal", "terminal"], ["tool_clients", "tool-clients"],
      ["connection", "connection"], ["environments", "environments"], ["backends", "backends"], ["projects", "projects"], ["server", "server"],
    ] as const) {
      const route = { name: "settings", page } as const;
      expect(settingsPath(page)).toBe(`/settings/${slug}`);
      expect(parseRoute(`/settings/${slug}`)).toEqual(route);
      expect(routePath(route)).toBe(`/settings/${slug}`);
    }
  });

  it.each(["/settings/", "/settings/unknown", "/settings/tool_clients", "/settings/paired_clients", "/settings/General", "/settings/%67eneral", "/settings/general/", "/settings/general/extra"])("rejects noncanonical category URL %s", pathname => {
    expect(parseRoute(pathname)).toEqual({ name: "home" });
  });
});

describe("resumable navigation", () => {
  it("resumes the original replace and preserves every other guard", () => {
    navigate("/settings/general", { replace: true });
    const initialLength = window.history.length;
    let firstProceed: (() => void) | undefined;
    let secondProceed: (() => void) | undefined;
    const first = vi.fn<NavigationBlocker>((_current, _next, proceed) => { firstProceed = proceed; return false; });
    const second = vi.fn<NavigationBlocker>((_current, _next, proceed) => { secondProceed = proceed; return false; });
    const removeFirst = installNavigationBlocker(first);
    const removeSecond = installNavigationBlocker(second);
    try {
      navigate("/settings/backends?source=test#details", { replace: true });
      expect(window.location.pathname).toBe("/settings/general");
      expect(second).not.toHaveBeenCalled();
      firstProceed!();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(window.location.pathname).toBe("/settings/general");
      secondProceed!();
      expect(window.location.pathname + window.location.search + window.location.hash).toBe("/settings/backends?source=test#details");
      expect(window.history.length).toBe(initialLength);
      firstProceed!();
      secondProceed!();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(window.history.length).toBe(initialLength);
    } finally { removeFirst(); removeSecond(); }
  });

  it("supports synchronous continuations and invalidates an older blocked intent", () => {
    navigate("/settings/general", { replace: true });
    const continuations: Array<() => void> = [];
    const remove = installNavigationBlocker((_current, _next, proceed) => { continuations.push(proceed); return false; });
    try {
      navigate("/settings/appearance");
      navigate("/settings/backends");
      continuations[0]!();
      expect(window.location.pathname).toBe("/settings/general");
      continuations[1]!();
      expect(window.location.pathname).toBe("/settings/backends");
    } finally { remove(); }
    const removeSynchronous = installNavigationBlocker((_current, _next, proceed) => { proceed(); return false; });
    try {
      navigate("/settings/terminal");
      expect(window.location.pathname).toBe("/settings/terminal");
    } finally { removeSynchronous(); }
  });

  it("restores canceled Back without adding entries and confirms the original traversal with Forward intact", async () => {
    navigate("/settings/general", { replace: true });
    navigate("/settings/appearance");
    navigate("/settings/backends");
    const initialLength = window.history.length;
    let proceed: (() => void) | undefined;
    const block = vi.fn<NavigationBlocker>((_current, _next, continuation) => { proceed = continuation; return false; });
    const remove = installNavigationBlocker(block);
    try {
      window.history.back();
      await vi.waitFor(() => { expect(block).toHaveBeenCalledOnce(); expect(window.location.pathname).toBe("/settings/backends"); });
      expect(window.history.length).toBe(initialLength);
      // Dismissing the caller's confirmation means not invoking its continuation.
      window.history.back();
      await vi.waitFor(() => { expect(block).toHaveBeenCalledTimes(2); expect(window.location.pathname).toBe("/settings/backends"); });
      proceed!();
      await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));
      expect(block).toHaveBeenCalledTimes(2);
      expect(window.history.length).toBe(initialLength);
    } finally { remove(); }
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/general"));
    window.history.forward();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));
    window.history.forward();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/backends"));
  });

  it("can confirm Forward immediately before its compensating Back event arrives", async () => {
    navigate("/settings/general", { replace: true });
    navigate("/settings/appearance");
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/general"));
    const block = vi.fn<NavigationBlocker>((_current, _next, proceed) => {
      queueMicrotask(proceed);
      return false;
    });
    const remove = installNavigationBlocker(block);
    const initialLength = window.history.length;
    try {
      window.history.forward();
      await vi.waitFor(() => { expect(block).toHaveBeenCalledOnce(); expect(window.location.pathname).toBe("/settings/appearance"); });
      expect(window.history.length).toBe(initialLength);
    } finally { remove(); }
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/general"));
  });

  it("starts a newer navigation from the published entry when it supersedes an in-flight approved Back", async () => {
    navigate("/settings/general", { replace: true });
    navigate("/settings/appearance");
    navigate("/settings/backends");
    const initialLength = window.history.length;
    let proceed: (() => void) | undefined;
    const remove = installNavigationBlocker((_current, _next, continuation) => { proceed = continuation; return false; });
    const nativeGo = window.history.go.bind(window.history);
    try {
      window.history.back();
      await vi.waitFor(() => { expect(proceed).toBeTypeOf("function"); expect(window.location.pathname).toBe("/settings/backends"); });
      let superseded = false;
      vi.spyOn(window.history, "go").mockImplementation(delta => {
        nativeGo(delta);
        if (delta === -1 && !superseded) {
          superseded = true;
          remove();
          navigate("/settings/terminal");
        }
      });
      proceed!();
      await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/terminal"));
      expect(window.history.length).toBe(initialLength + 1);
    } finally { remove(); vi.restoreAllMocks(); }
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/backends"));
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/appearance"));
  });

  it("preserves terminal duplicate entries and caller history state through blocked traversals", async () => {
    navigate("/threads/source", { replace: true });
    const previousState: unknown = window.history.state;
    pushHistoryEntry({ ...window.history.state, terminalMarker: "open" }, window.location.href);
    const terminalState: unknown = window.history.state;
    // Closing a viewer without Back updates its marker without borrowing the
    // prior entry's router position, then the viewer can remain on that entry.
    replaceHistoryEntry(previousState, window.location.href);
    expect(window.history.state.terminalMarker).toBeUndefined();
    replaceHistoryEntry(terminalState, window.location.href);
    navigate("/settings/backends");
    const initialLength = window.history.length;
    let proceed: (() => void) | undefined;
    const remove = installNavigationBlocker((current, next, continuation) => {
      if (sameRoute(current, next)) return true;
      proceed = continuation;
      return false;
    });
    try {
      window.history.back();
      await vi.waitFor(() => { expect(proceed).toBeTypeOf("function"); expect(window.location.pathname).toBe("/settings/backends"); });
      proceed!();
      await vi.waitFor(() => expect(window.location.pathname).toBe("/threads/source"));
      expect(window.history.state.terminalMarker).toBe("open");
      window.history.back();
      await vi.waitFor(() => expect(window.history.state.terminalMarker).toBeUndefined());
      expect(window.location.pathname).toBe("/threads/source");
      expect(window.history.length).toBe(initialLength);
    } finally { remove(); }
    window.history.forward();
    await vi.waitFor(() => expect(window.history.state.terminalMarker).toBe("open"));
    window.history.forward();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/backends"));
  });
});
