// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ContextExcerpt } from "../../shared/index.js";
import { ComposerDraftCoordinator } from "./coordinator.js";

const excerpt: ContextExcerpt = {
  id: "5d67ba29-4141-49f9-b5fb-34b54c65cc10",
  excerpt: "const answer = 42;",
  source: {
    kind: "workspace_file",
    rootId: "primary",
    path: "src/answer.ts",
    revision: "revision-1",
  },
  locator: { kind: "line_range", startLine: 3, endLine: 3 },
};

describe("ComposerDraftCoordinator", () => {
  it("fails closed without a mounted composer and after its route is disposed", () => {
    const coordinator = new ComposerDraftCoordinator("thread-1", "workspace-1");
    expect(coordinator.stage(excerpt)).toEqual({
      ok: false,
      reason: "The message composer is unavailable.",
    });

    coordinator.dispose();
    expect(coordinator.stage(excerpt)).toEqual({
      ok: false,
      reason: "The active thread changed. Select the excerpt again.",
    });
  });

  it("publishes consumer availability and unregisters the exact consumer", () => {
    const coordinator = new ComposerDraftCoordinator("thread-1", "workspace-1");
    const listener = vi.fn();
    coordinator.subscribe(listener);
    const stage = vi.fn(() => ({ ok: true as const }));
    const unregister = coordinator.registerConsumer({
      stage,
      attachAndSubmit: vi.fn(() => ({ ok: true as const })),
      stageTaskReference: vi.fn(() => ({ ok: true as const })),
      getSnapshot: () => ({ available: true }),
    });

    expect(coordinator.stage(excerpt)).toMatchObject({ ok: true });
    expect(stage).toHaveBeenCalledWith(excerpt);
    unregister();
    expect(coordinator.getSnapshot().available).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("routes atomic attach-and-submit through the mounted composer", () => {
    const coordinator = new ComposerDraftCoordinator("thread-1", "workspace-1");
    const attachAndSubmit = vi.fn(() => ({ ok: true as const }));
    coordinator.registerConsumer({
      stage: vi.fn(() => ({ ok: true as const })),
      attachAndSubmit,
      stageTaskReference: vi.fn(() => ({ ok: true as const })),
      getSnapshot: () => ({ available: true }),
    });

    expect(coordinator.attachAndSubmit(excerpt)).toEqual({ ok: true });
    expect(attachAndSubmit).toHaveBeenCalledWith(excerpt);
  });

  it("supports reactive availability snapshots", () => {
    const coordinator = new ComposerDraftCoordinator("thread-1", "workspace-1");
    let available = false;
    coordinator.registerConsumer({
      stage: () => ({ ok: true }),
      attachAndSubmit: () => ({ ok: true }),
      stageTaskReference: () => ({ ok: true }),
      getSnapshot: () => ({ available }),
    });
    const { result } = renderHook(() =>
      useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot),
    );
    expect(result.current.available).toBe(false);
    available = true;
    act(() => coordinator.notify());
    expect(result.current.available).toBe(true);
  });

  it("stages exact task references", () => {
    const coordinator = new ComposerDraftCoordinator("thread-1", "workspace-1");
    const stageTaskReference = vi.fn(() => ({ ok: true as const }));
    coordinator.registerConsumer({
      stage: () => ({ ok: true }),
      attachAndSubmit: () => ({ ok: true }),
      stageTaskReference,
      getSnapshot: () => ({ available: true }),
    });
    const reference = { taskId: "task-1", titleSnapshot: "Write docs" };
    const result = coordinator.stageTaskReference(reference);
    expect(result).toMatchObject({ ok: true });
    expect(stageTaskReference).toHaveBeenCalledWith(reference);
  });
});
