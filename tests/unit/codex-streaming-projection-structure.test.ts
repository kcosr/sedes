import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

describe("Codex streaming projection structure", () => {
  const handle = source(
    "../../src/server/backends/codex/codex-conversation-handle.ts",
  );
  const overlay = source(
    "../../src/server/backends/codex/codex-live-projection-overlay.ts",
  );

  it("keeps high-rate notification cases on the item-local overlay", () => {
    const deltaCases = between(
      handle,
      'case "item/agentMessage/delta":',
      'case "item/fileChange/outputDelta":',
    );

    expect(deltaCases).not.toMatch(
      /projectCodexThreadHistory|#projectThreadHistory|#installProjection|structuredClone|JSON\.stringify|\.turns\.(?:find|map)/u,
    );
    expect(deltaCases).toMatch(/#liveProjectionOverlay/u);
  });

  it("projects a flush without enumerating or cloning complete entity maps", () => {
    const flush = between(
      handle,
      "  #flushLiveProjection(",
      "  #invalidateProjection(",
    );

    expect(flush).toContain("projectCodexItemSlice");
    expect(flush).toContain("isTailExtension");
    expect(flush).not.toMatch(
      /projectCodexThreadHistory|#projectThreadHistory|Object\.(?:keys|values|entries|fromEntries)|structuredClone|\.turns\.(?:find|map|filter)/u,
    );
  });

  it("advances the local cadence after projected no-ops", () => {
    const flush = between(overlay, "  #flushDue(", "  #reschedule(");

    expect(flush).toContain("entry.lastProjectedAt = now");
    expect(flush).not.toMatch(/published\.has/u);
  });

  it("verifies a projector byte receipt without a vacuous post-install serialization", () => {
    const install = between(
      handle,
      "  #installProjection(",
      "  #validateThread(",
    );

    expect(install).toContain("verifiedCodexProjectionBytes(projection)");
    expect(
      install.match(/serializedUtf8Bytes\(this\.#snapshotWindow\)/gu),
    ).toHaveLength(1);
    expect(handle).not.toContain("#fullSnapshot");
  });

  it("removes the prior per-delta whole-history helpers", () => {
    expect(handle).not.toMatch(
      /function applyNativeTextDelta|function applyNativeReasoningProgress|#installAndEmitProgressUpdate|function findChangedProjectedItem/u,
    );
  });
});
