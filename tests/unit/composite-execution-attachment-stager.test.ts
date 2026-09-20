import { describe, expect, it, vi } from "vitest";
import { CompositeExecutionAttachmentStager } from "../../src/server/composer-attachments/composite-execution-attachment-stager.js";
import type {
  ExecutionAttachmentMaterializationRequest,
  ExecutionAttachmentStager,
} from "../../src/server/composer-attachments/execution-attachment-stager.js";

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const foreign = { ...scope, principalId: "other" };
function provider(): ExecutionAttachmentStager {
  return {
    supports: () => true,
    materialize: vi.fn(async () => ({
      agentPath: "/attachment",
      sha256: "digest",
      sizeBytes: 1,
    })),
    release: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

describe("mutable attachment staging routing", () => {
  it("adds, replaces, and removes exact environments under the captured principal", async () => {
    const composite = new CompositeExecutionAttachmentStager({
      scope,
      providers: new Map(),
    });
    const first = provider();
    const next = provider();
    const request = {
      lease: { environment: { id: "env" } },
    } as ExecutionAttachmentMaterializationRequest;
    expect(composite.supports(scope, "env")).toBe(false);
    composite.set(scope, "env", first);
    await composite.materialize(scope, request);
    composite.set(scope, "env", next);
    await composite.materialize(scope, request);
    expect(first.materialize).toHaveBeenCalledOnce();
    expect(next.materialize).toHaveBeenCalledOnce();
    expect(() => composite.set(foreign, "env", first)).toThrow(
      "composer_attachment_staging_unavailable",
    );
    expect(() => composite.remove(foreign, "env")).toThrow(
      "composer_attachment_staging_unavailable",
    );
    expect(composite.supports(foreign, "env")).toBe(false);
    await expect(composite.materialize(foreign, request)).rejects.toThrow(
      "composer_attachment_staging_unavailable",
    );
    composite.remove(scope, "env");
    await expect(composite.materialize(scope, request)).rejects.toThrow(
      "composer_attachment_staging_unavailable",
    );
    expect(first.close).not.toHaveBeenCalled(); // Reconciliation owns retired-provider cleanup.
    expect(next.close).not.toHaveBeenCalled();
  });
});
