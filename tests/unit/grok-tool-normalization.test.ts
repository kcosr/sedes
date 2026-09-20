import { describe, expect, it, vi } from "vitest";
import {
  decodeGrokCanonicalToolMetadata,
  decodeGrokRawToolOutputVariant,
  inspectGrokToolNormalization,
} from "../../src/server/backends/grok/grok-tool-normalization.js";

function toolMeta(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    retainedSibling: true,
    "x.ai/tool": {
      version: 1,
      name: "read_file",
      kind: "read",
      namespace: "grok_build",
      label: "Read",
      read_only: true,
      input: { path: "src/app.ts", offset: 3, limit: 8 },
      additive: { ignored: true },
      ...overrides,
    },
  };
}

describe("Grok private tool normalization", () => {
  it("strictly decodes v1 required fields while projecting additive fields away", () => {
    expect(decodeGrokCanonicalToolMetadata(toolMeta())).toEqual({
      version: 1,
      name: "read_file",
      kind: "read",
      namespace: "grok_build",
      label: "Read",
      readOnly: true,
      input: { path: "src/app.ts", offset: 3, limit: 8 },
    });
    expect(
      decodeGrokCanonicalToolMetadata(
        toolMeta({ kind: "future_kind", namespace: "future_toolset" }),
      ),
    ).toMatchObject({ kind: "other", namespace: "future_toolset" });
  });

  it.each([
    { version: 2 },
    { version: "1" },
    { name: 1 },
    { kind: null },
    { namespace: null },
    { label: false },
    { read_only: "yes" },
  ])("treats malformed metadata as absent: %o", (override) => {
    expect(decodeGrokCanonicalToolMetadata(toolMeta(override))).toBeUndefined();
  });

  it("does not execute accessors while inspecting provider records", () => {
    const getter = vi.fn(() => toolMeta()["x.ai/tool"]);
    const meta = {};
    Object.defineProperty(meta, "x.ai/tool", { get: getter });
    expect(decodeGrokCanonicalToolMetadata(meta)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["Bash", "WebSearch", "MCP", "ImageGen", "ImageEdit"] as const)(
    "accepts the exact Pascal-case raw output variant %s",
    (type) => {
      expect(decodeGrokRawToolOutputVariant({ type, added: true })).toBe(type);
    },
  );

  it.each([
    "bash_output",
    "bash",
    "web_search",
    "Mcp",
    "ImageGeneration",
    "imageEdit",
  ])("rejects invented or case-shifted raw output variant %s", (type) => {
    expect(decodeGrokRawToolOutputVariant({ type })).toBeUndefined();
  });

  it("derives command evidence from canonical input and exact Bash output", () => {
    expect(
      inspectGrokToolNormalization(
        toolMeta({
          name: "run_terminal_cmd",
          kind: "execute",
          label: "Run Command",
          read_only: false,
          input: { command: "npm test", cwd: "/workspace" },
        }),
        undefined,
        undefined,
      ).disposition,
    ).toEqual({
      semanticKind: "command",
      command: "npm test",
      cwd: "/workspace",
    });

    expect(
      inspectGrokToolNormalization(undefined, undefined, {
        type: "Bash",
        command: "pwd",
        current_dir: "/repo",
      }),
    ).toMatchObject({
      rawOutputVariant: "Bash",
      disposition: {
        semanticKind: "command",
        command: "pwd",
      },
    });
  });

  it("derives file read and file change only when required structures exist", () => {
    expect(
      inspectGrokToolNormalization(toolMeta(), undefined, undefined)
        .disposition,
    ).toEqual({
      semanticKind: "file_read",
      path: "src/app.ts",
      offset: 3,
      limit: 8,
    });
    expect(
      inspectGrokToolNormalization(
        toolMeta({
          name: "search_replace",
          kind: "edit",
          label: "Edit",
          read_only: false,
          input: { path: "src/app.ts" },
        }),
        undefined,
        undefined,
      ).disposition,
    ).toEqual({
      semanticKind: "file_change",
      operation: "edit",
      path: "src/app.ts",
    });
    expect(
      inspectGrokToolNormalization(
        toolMeta({ kind: "move", input: { path: "old.ts" } }),
        undefined,
        undefined,
      ),
    ).toMatchObject({
      disposition: { semanticKind: "tool", category: "filesystem" },
      deferUntilRefinement: true,
    });
  });

  it("derives web-search evidence from typed input or exact source output", () => {
    expect(
      inspectGrokToolNormalization(
        toolMeta({
          name: "web_search",
          kind: "web_search",
          label: "Web Search",
          input: undefined,
        }),
        { query: "ACP protocol" },
        undefined,
      ).disposition,
    ).toEqual({ semanticKind: "web_search", query: "ACP protocol" });
    expect(
      inspectGrokToolNormalization(undefined, undefined, {
        type: "WebSearch",
        action: { query: "Grok tools" },
      }).disposition,
    ).toEqual({ semanticKind: "web_search", query: "Grok tools" });
  });

  it("uses the reviewed exact MCP qualification structure", () => {
    expect(
      inspectGrokToolNormalization(
        toolMeta({
          name: "linear__create_issue",
          kind: "other",
          namespace: "mcp",
          label: "Tool",
          input: undefined,
        }),
        { title: "Bug" },
        { type: "MCP" },
      ),
    ).toMatchObject({
      rawOutputVariant: "MCP",
      disposition: {
        semanticKind: "mcp",
        server: "linear",
        toolName: "create_issue",
      },
    });
    expect(
      inspectGrokToolNormalization(
        toolMeta({
          name: "ambiguous__tool__name",
          kind: "other",
          namespace: "mcp",
          label: "Tool",
          input: undefined,
        }),
        undefined,
        undefined,
      ).disposition,
    ).toMatchObject({ semanticKind: "tool", category: "other" });
  });

  it("never infers semantics from persuasive names or labels", () => {
    const evidence = inspectGrokToolNormalization(
      toolMeta({
        name: "definitely_run_command_and_edit_file",
        kind: "other",
        namespace: "grok_build",
        label: "Web Search MCP Bash Read Edit",
        input: { command: "rm something", path: "secret" },
      }),
      { query: "pretend" },
      { type: "bash_output", command: "also pretend" },
    );
    expect(evidence.rawOutputVariant).toBeUndefined();
    expect(evidence.disposition).toEqual({
      semanticKind: "tool",
      toolName: "definitely_run_command_and_edit_file",
      title: "Web Search MCP Bash Read Edit",
      category: "other",
    });
  });

  it("retains image generation and edit variants as artifact evidence without inventing a shape", () => {
    for (const type of ["ImageGen", "ImageEdit"] as const) {
      const evidence = inspectGrokToolNormalization(
        toolMeta({
          name: type === "ImageGen" ? "image_gen" : "image_edit",
          kind: "image_gen",
          label: type === "ImageGen" ? "Generate Image" : "Edit Image",
          read_only: false,
          input: undefined,
        }),
        undefined,
        { type, path: "/tmp/image.png" },
      );
      expect(evidence.rawOutputVariant).toBe(type);
      expect(evidence.disposition.semanticKind).toBe("tool");
    }
  });
});
