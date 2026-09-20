import { describe, expect, it, vi } from "vitest";
import type {
  ContextExcerpt,
  WorkspaceDiffContextSource,
} from "../../shared/index.js";
import type { ContextExcerptStagingTarget } from "./coordinator.js";
import { stageWorkspaceDiffContextExcerpt } from "./workspace-diff-staging.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const source = {
  kind: "workspace_diff",
  workspaceId,
  rootId: "primary",
  comparisonId: "comparison_1234567890abcdef",
  comparisonFingerprint: "fingerprint_1234567890abcdef",
  fileId: "file_1234567890abcdef",
  oldPath: "src/old.ts",
  newPath: "src/new.ts",
} as WorkspaceDiffContextSource;

describe("stageWorkspaceDiffContextExcerpt", () => {
  it("stages exact immutable diff provenance through the active workspace target", () => {
    const staged: ContextExcerpt[] = [];
    const target = createTarget({
      stage: (excerpt) => {
        staged.push(excerpt);
        return { ok: true };
      },
    });
    expect(
      stageWorkspaceDiffContextExcerpt({
        target,
        sourceStatus: availableSourceStatus(),
        candidate: {
          id: "20000000-0000-4000-8000-000000000002",
          excerpt: "-old\n+new\n",
          note: "  Check behavior.  ",
          source,
          locator: {
            kind: "diff_line_range",
            start: { side: "old", line: 4 },
            end: { side: "new", line: 5 },
          },
        },
      }),
    ).toEqual({ ok: true });
    expect(staged).toEqual([
      expect.objectContaining({
        excerpt: "-old\n+new\n",
        note: "Check behavior.",
        source,
        locator: {
          kind: "diff_line_range",
          start: { side: "old", line: 4 },
          end: { side: "new", line: 5 },
        },
      }),
    ]);
  });

  it("fails closed for stale, unavailable, mismatched, and wrong-workspace state", () => {
    const stage = vi.fn(() => ({ ok: true as const }));
    const target = createTarget({ stage });
    const candidate = {
      id: "20000000-0000-4000-8000-000000000002",
      excerpt: "+new\n",
      source,
      locator: {
        kind: "diff_line_range" as const,
        start: { side: "new" as const, line: 5 },
        end: { side: "new" as const, line: 5 },
      },
    };
    expect(
      stageWorkspaceDiffContextExcerpt({
        target,
        sourceStatus: { status: "stale" },
        candidate,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("changed") });
    expect(
      stageWorkspaceDiffContextExcerpt({
        target,
        sourceStatus: { status: "unavailable", reason: "Repository offline." },
        candidate,
      }),
    ).toEqual({ ok: false, reason: "Repository offline." });
    expect(
      stageWorkspaceDiffContextExcerpt({
        target,
        sourceStatus: {
          ...availableSourceStatus(),
          fileId: "another_file" as never,
        },
        candidate,
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("displayed diff"),
    });
    expect(
      stageWorkspaceDiffContextExcerpt({
        target: createTarget({
          workspaceId: "30000000-0000-4000-8000-000000000003",
          stage,
        }),
        sourceStatus: availableSourceStatus(),
        candidate,
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("active thread workspace"),
    });
    expect(stage).not.toHaveBeenCalled();
  });

  it("retains explicit old and new endpoints for a cross-side selection", () => {
    const staged: ContextExcerpt[] = [];
    const stage = vi.fn((excerpt: ContextExcerpt) => {
      staged.push(excerpt);
      return { ok: true as const };
    });
    const result = stageWorkspaceDiffContextExcerpt({
      target: createTarget({ stage }),
      sourceStatus: availableSourceStatus(),
      candidate: {
        excerpt: "-old\n+new\n",
        source,
        locator: {
          kind: "diff_line_range",
          start: { side: "old", line: 5 },
          end: { side: "new", line: 5 },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    expect(stage).toHaveBeenCalledOnce();
    expect(staged[0]?.locator).toEqual({
      kind: "diff_line_range",
      start: { side: "old", line: 5 },
      end: { side: "new", line: 5 },
    });
  });

  it("routes immediate delivery without staging first", () => {
    const stage = vi.fn(() => ({ ok: true as const }));
    const attachAndSubmit = vi.fn(() => ({ ok: true as const }));
    const result = stageWorkspaceDiffContextExcerpt({
      target: createTarget({ stage, attachAndSubmit }),
      sourceStatus: availableSourceStatus(),
      sendImmediately: true,
      candidate: {
        excerpt: "+new\n",
        note: "Explain this.",
        source,
        locator: {
          kind: "diff_line_range",
          start: { side: "new", line: 5 },
          end: { side: "new", line: 5 },
        },
      },
    });
    expect(result).toEqual({ ok: true });
    expect(stage).not.toHaveBeenCalled();
    expect(attachAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ excerpt: "+new\n", note: "Explain this." }),
    );
  });
});

function availableSourceStatus() {
  return {
    status: "available" as const,
    comparisonId: source.comparisonId,
    comparisonFingerprint: source.comparisonFingerprint,
    fileId: source.fileId,
  };
}

function createTarget(overrides: {
  readonly workspaceId?: string;
  readonly stage: ContextExcerptStagingTarget["stage"];
  readonly attachAndSubmit?: ContextExcerptStagingTarget["attachAndSubmit"];
}): ContextExcerptStagingTarget {
  return {
    threadId: "thread-1",
    workspaceId: overrides.workspaceId ?? workspaceId,
    getSnapshot: () => ({ available: true }),
    subscribe: () => () => undefined,
    stage: overrides.stage,
    attachAndSubmit: overrides.attachAndSubmit ?? overrides.stage,
  };
}
