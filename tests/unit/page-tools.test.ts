import { describe, expect, it, vi } from "vitest";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { createPageToolDefinitions } from "../../src/server/agent-tools/tools/page-management-tools.js";
import { PageAgentToolService } from "../../src/server/agent-tools/tools/page-agent-tool-service.js";
import { AgentToolOutput } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";

describe("HTML page canonical tools", () => {
  it("reports downscaled screenshot dimensions separately from the CSS viewport", async () => {
    const service = new PageAgentToolService({ pages: { prepare: async () => ({ escapedHtml: "authored", bootstrapOffset: 0 }) } as never,
      capturePublication: vi.fn(), preview: async () => ({
        width: 3840, height: 2160, contentWidth: 3840, contentHeight: 2160, console: [],
        screenshot: { mimeType: "image/png", data: "aW1hZ2U=", width: 1920, height: 1080 },
      }),
    });
    const result = await service.execute("preview", { html: "<p>Preview</p>" }, {
      subject: { kind: "thread_agent", sourceThreadId: "thread" }, tenantId: "tenant", principalId: "principal",
    } as never);
    expect(result).toBeInstanceOf(AgentToolOutput);
    expect((result as AgentToolOutput<unknown>).output).toMatchObject({ width: 3840, height: 2160, screenshot: { width: 1920, height: 1080, byteSize: 5 } });
  });
  it("recovers the exact inline source or file path for current and historical revisions", async () => {
    const pageId = "323b0d83-0d81-455b-a3da-38e394ca6e90";
    const get = vi.fn((_scope, _thread, _pageId, revision) => ({ pageId, revision: revision ?? 2 }));
    const source = vi.fn((_scope, _thread, _pageId, revision) => revision === 1
      ? { path: "/work/original.html", html: "<p>file snapshot</p>" }
      : { html: "<p>saved inline source</p>" });
    const service = new PageAgentToolService({ pages: { get, source } as never, capturePublication: vi.fn() });
    const context = { subject: { kind: "thread_agent", sourceThreadId: "thread" }, tenantId: "tenant", principalId: "principal" } as never;
    expect(await service.execute("get", { pageId }, context)).toEqual({ page: { pageId, revision: 2 }, html: "<p>saved inline source</p>" });
    expect(await service.execute("get", { pageId, revision: 1 }, context)).toEqual({ page: { pageId, revision: 1 }, sourcePath: "/work/original.html" });
    expect(source).toHaveBeenLastCalledWith({ tenantId: "tenant", principalId: "principal" }, "thread", pageId, 1);
  });
  it("uses identical bounded definitions for all native and CLI transports", () => {
    const definitions = createPageToolDefinitions({} as PageAgentToolService);
    const registry = new AgentToolRegistry();
    for (const definition of definitions) {
      registry.register(definition);
      expect(definition.callerEligibility).toEqual(["thread_agent"]);
      expect(definition.exposure.adapters).toEqual(["pi_sdk", "mcp", "http", "cli"]);
      expect(definition.adapters.pi?.name).toBe(definition.adapters.mcp?.name);
    }
    expect(registry.validatesInput("page.publish", 1, { path: "/work/page.html", title: "Phone", viewport: { width: 390 } })).toBe(true);
    expect(registry.validatesInput("page.publish", 1, { html: "<div>inline</div>", title: "Phone" })).toBe(true);
    expect(registry.validatesInput("page.publish", 1, { path: "/work/page.html", title: "Phone", viewport: { width: 10_000 } })).toBe(false);
  });

  it("uses only the authenticated source thread and captures its publication fence before importing", async () => {
    const assertCurrent = vi.fn();
    const capturePublication = vi.fn(() => ({ anchor: { turnId: "turn" }, assertCurrent }));
    const publish = vi.fn(async () => ({ changed: true }));
    const service = new PageAgentToolService({ pages: { publish } as never, capturePublication });
    await service.execute("publish", { path: "/work/page.html", title: "Page" }, {
      subject: { kind: "thread_agent", sourceThreadId: "source" }, tenantId: "tenant", principalId: "principal", invocationId: "invocation",
    } as never);
    expect(capturePublication).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "source");
    expect(publish).toHaveBeenCalledWith({ tenantId: "tenant", principalId: "principal" }, "source", { path: "/work/page.html", title: "Page" },
      { invocationId: "invocation", anchor: { turnId: "turn" }, assertCurrent }, undefined);
    await expect(service.execute("publish", { path: "/work/page.html", title: "Page", threadId: "other" }, {
      subject: { kind: "thread_agent", sourceThreadId: "source" },
    } as never)).rejects.toThrow();
    for (const source of [{}, { path: "/work/page.html", html: "<div>two sources</div>" }]) {
      await expect(service.execute("publish", { ...source, title: "Page" }, {
        subject: { kind: "thread_agent", sourceThreadId: "source" },
      } as never)).rejects.toThrow("exactly one");
    }
    await expect(service.execute("list", {}, { subject: { kind: "principal_client" } } as never)).rejects.toThrow("source thread");
  });
});
