import { describe, expect, it, vi } from "vitest";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { createImageShowToolDefinition } from "../../src/server/agent-tools/tools/image-show-tool.js";
import { ImageShowAgentToolService } from "../../src/server/agent-tools/tools/image-show-agent-tool-service.js";
import { mapAgentToolDomainError } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { ImageShowError } from "../../src/server/output-artifacts/image-show-error.js";
import { displayFileName } from "../../src/server/output-artifacts/display-file-name.js";

describe("image.show canonical tool", () => {
  it("exposes the same metadata-only contract through each supported transport", () => {
    const definition = createImageShowToolDefinition({} as ImageShowAgentToolService);
    const registry = new AgentToolRegistry();
    registry.register(definition);
    expect(definition.callerEligibility).toEqual(["thread_agent"]);
    expect(definition.environmentAuthority).toEqual({ kind: "source_only" });
    expect(definition.catalog).toMatchObject({ groupId: "images", label: "Show image" });
    expect(definition.adapters.pi?.name).toBe("sedes_image_show");
    expect(definition.adapters.mcp?.name).toBe("sedes_image_show");
    expect(definition.adapters.cli?.command).toBe("image.show");
    expect(definition.exposure.adapters).toEqual(["pi_sdk", "mcp", "http", "cli"]);
    expect(definition.outputMediaTypes).toBeUndefined();
    expect(definition.execution.idempotency).toBe("supported");
    expect(definition.description).toContain("image");
    expect(registry.validatesInput("image.show", 1, { path: "/work/chart.png", title: "Results" })).toBe(true);
    expect(registry.validatesInput("image.show", 1, { path: "/work/chart.png", threadId: "other" })).toBe(false);
    expect(registry.validatesInput("image.show", 1, { path: "/work/chart.png", title: "a".repeat(241) })).toBe(false);
    const image = { representation: "artifact", artifactId: "40000000-0000-4000-8000-000000000001",
      mimeType: "image/png", byteSize: 100, sha256: "a".repeat(64), alt: { text: "Results" }, fileName: { text: "chart.png" } };
    expect(registry.validatesOutput("image.show", 1, { image })).toBe(true);
    const fileName = displayFileName(`C:\\work\\${"é".repeat(160)}.png`);
    expect(fileName?.truncation?.truncated).toBe(true);
    expect(registry.validatesOutput("image.show", 1, { image: { ...image, fileName } })).toBe(true);
    expect(registry.validatesOutput("image.show", 1, { image, modelContent: [] })).toBe(false);
  });

  it("uses authenticated source identity and stable request ID with a lazy turn lease", async () => {
    const capturePublication = vi.fn(() => ({ anchor: { turnId: "turn" }, assertCurrent: vi.fn() }));
    const show = vi.fn(async () => ({ image: { artifactId: "image" } }));
    const service = new ImageShowAgentToolService({ images: { show } as never, capturePublication });
    const context = { subject: { kind: "thread_agent", sourceThreadId: "source" },
      tenantId: "tenant", principalId: "principal", requestId: "stable-request", invocationId: "ephemeral-invocation",
      abortSignal: new AbortController().signal } as never;
    await service.execute({ path: "/work/chart.png", title: "  Results  " }, context);
    expect(show).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "source",
      { path: "/work/chart.png", title: "Results" }, { invocationId: "stable-request", capture: expect.any(Function) },
      expect.any(AbortSignal));
    expect(capturePublication).not.toHaveBeenCalled();
    (show.mock.calls[0] as unknown as [unknown, unknown, unknown, { capture: () => unknown }])[3].capture();
    expect(capturePublication).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "source");
    await expect(service.execute({ path: "/work/chart.png" }, { subject: { kind: "principal_client" } } as never))
      .rejects.toThrow("requires a source thread");
    await expect(service.execute({ path: "relative.png" }, context)).rejects.toThrow("normalized absolute");
    await expect(service.execute({ path: `/${"é".repeat(2048)}` }, context)).rejects.toThrow("Files path limit");
    await expect(service.execute({ path: "/work/chart.png", threadId: "other" }, context)).rejects.toThrow();
  });

  it.each([
    "C:\\work\\chart.png",
    "\\\\files\\share\\chart.png",
  ])("preserves native Windows image path %s through the tool adapter", async nativePath => {
    const capturePublication = vi.fn();
    const show = vi.fn(async () => ({ image: { artifactId: "image" } }));
    const service = new ImageShowAgentToolService({ images: { show } as never, capturePublication });
    const context = { subject: { kind: "thread_agent", sourceThreadId: "source" },
      tenantId: "tenant", principalId: "principal", requestId: "windows-request",
      abortSignal: new AbortController().signal } as never;

    await service.execute({ path: nativePath }, context);

    expect(show).toHaveBeenCalledExactlyOnceWith({ tenantId: "tenant", principalId: "principal" },
      "source", { path: nativePath }, { invocationId: "windows-request", capture: expect.any(Function) },
      expect.any(AbortSignal));
    expect(capturePublication).not.toHaveBeenCalled();
  });

  it.each([
    "C:chart.png", "C:\\work\\..\\chart.png", "C:\\work\\chart.png:stream",
    "\\\\?\\C:\\work\\chart.png", "\\\\files\\share\\..\\chart.png",
  ])("rejects ambiguous Windows image path %s before source dispatch", async nativePath => {
    const show = vi.fn();
    const capturePublication = vi.fn();
    const service = new ImageShowAgentToolService({ images: { show } as never, capturePublication });
    const context = { subject: { kind: "thread_agent", sourceThreadId: "source" },
      tenantId: "tenant", principalId: "principal", requestId: "invalid-windows-request" } as never;

    await expect(service.execute({ path: nativePath }, context)).rejects.toThrow("normalized absolute");

    expect(show).not.toHaveBeenCalled();
    expect(capturePublication).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "invalid", "size", "unavailable", "changed", "busy", "cancelled", "request_conflict", "inactive_turn", "turn_limit", "retention_failed"] as const)(
    "preserves the fixed safe %s error at the canonical transport boundary", (reason) => {
      const error = new ImageShowError(reason);
      const mapped = mapAgentToolDomainError(error);
      expect(mapped.message).toBe(error.message);
      expect(mapped.retryable).toBe(error.retryable);
      expect(mapped.message).not.toContain("/work/");
    },
  );
});
