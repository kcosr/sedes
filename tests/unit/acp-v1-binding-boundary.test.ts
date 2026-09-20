import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bindingRoot = path.resolve(
  "src/server/provider-protocol/bindings/acp-v1",
);

describe("ACP V1 binding boundary", () => {
  it("allows only the reviewed public stable SDK constants and types", () => {
    const files = sourceFiles(bindingRoot)
      .filter((file) => !file.includes(`${path.sep}generated${path.sep}`))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }));
    expect(
      files.flatMap(({ file, source }) =>
        invalidSdkImports(source).map((issue) => `${file}: ${issue}`),
      ),
    ).toEqual([]);

    const sources = files.map(({ source }) => source).join("\n");

    expect(sources).not.toMatch(
      /@agentclientprotocol\/sdk\/(?!schema\/schema\.json)/u,
    );
    expect(sources).not.toMatch(
      /(?:backends\/|Codex|codex|Grok|grok|x\.ai\/|BackendKind|conversation driver)/u,
    );
  });

  it("rejects public SDK engines and non-reviewed root exports", () => {
    for (const name of ["agent", "client", "ClientApp", "Stream", "V2Thing"]) {
      expect(
        invalidSdkImports(
          `import { ${name} } from "@agentclientprotocol/sdk";`,
        ),
      ).toEqual([`root export ${name} is not allowed`]);
    }
    expect(
      invalidSdkImports(
        'import { type ActiveSession } from "@agentclientprotocol/sdk";',
      ),
    ).toEqual(["root export ActiveSession is not allowed"]);
    expect(
      invalidSdkImports(
        'import { foo } from "@agentclientprotocol/sdk/dist/acp.js";',
      ),
    ).toEqual(["SDK deep import is not allowed"]);
    expect(
      invalidSdkImports(`
        import { decodeInitializeRequest } from "./generated/projectors.js";
        import { AGENT_METHODS, type InitializeRequest } from "@agentclientprotocol/sdk";
      `),
    ).toEqual([]);
    expect(
      invalidSdkImports(`
        import { innocent } from "./local.js";
        import { agent as hidden } from "@agentclientprotocol/sdk";
      `),
    ).toEqual(["aliased root export agent as hidden is not allowed"]);
  });

  it("uses the public schema artifact only in the generator", () => {
    const generator = readFileSync(
      "scripts/provider-protocol/generate-acp-v1-bindings.mjs",
      "utf8",
    );
    expect(generator).toContain("@agentclientprotocol/sdk/schema/schema.json");
    expect(generator).not.toMatch(/@agentclientprotocol\/sdk\/dist\//u);
  });

  it("keeps the official SDK dependency exact", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["@agentclientprotocol/sdk"]).toBe(
      "1.3.0",
    );
  });
});

const ALLOWED_RUNTIME_ROOT_EXPORTS = new Set([
  "AGENT_METHODS",
  "CLIENT_METHODS",
  "PROTOCOL_METHODS",
  "PROTOCOL_VERSION",
]);

const ALLOWED_TYPE_ROOT_EXPORTS = new Set([
  "AgentCapabilities",
  "AuthenticateRequest",
  "AuthenticateResponse",
  "CancelNotification",
  "CancelRequestNotification",
  "ClientCapabilities",
  "CloseSessionRequest",
  "CloseSessionResponse",
  "CreateTerminalRequest",
  "CreateTerminalResponse",
  "DeleteSessionRequest",
  "DeleteSessionResponse",
  "ForkSessionRequest",
  "ForkSessionResponse",
  "InitializeRequest",
  "InitializeResponse",
  "KillTerminalRequest",
  "KillTerminalResponse",
  "ListSessionsRequest",
  "ListSessionsResponse",
  "LoadSessionRequest",
  "LoadSessionResponse",
  "LogoutRequest",
  "LogoutResponse",
  "NewSessionRequest",
  "NewSessionResponse",
  "PromptRequest",
  "PromptResponse",
  "ReadTextFileRequest",
  "ReadTextFileResponse",
  "ReleaseTerminalRequest",
  "ReleaseTerminalResponse",
  "RequestPermissionRequest",
  "RequestPermissionResponse",
  "ResumeSessionRequest",
  "ResumeSessionResponse",
  "SessionNotification",
  "SetSessionConfigOptionRequest",
  "SetSessionConfigOptionResponse",
  "SetSessionModeRequest",
  "SetSessionModeResponse",
  "TerminalOutputRequest",
  "TerminalOutputResponse",
  "WaitForTerminalExitRequest",
  "WaitForTerminalExitResponse",
  "WriteTextFileRequest",
  "WriteTextFileResponse",
]);

function invalidSdkImports(source: string): string[] {
  const issues: string[] = [];
  const pattern =
    /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;/gu;
  for (const match of source.matchAll(pattern)) {
    const clause = (match[1] ?? "").trim();
    const moduleName = match[2] ?? "";
    if (moduleName.startsWith("@agentclientprotocol/sdk/")) {
      issues.push("SDK deep import is not allowed");
      continue;
    }
    if (moduleName !== "@agentclientprotocol/sdk") continue;
    const declarationTypeOnly = clause.startsWith("type ");
    const bindings = clause.replace(/^type\s+/u, "").trim();
    if (!bindings.startsWith("{") || !bindings.endsWith("}")) {
      issues.push("default or namespace SDK import is not allowed");
      continue;
    }
    for (const raw of bindings.slice(1, -1).split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const itemTypeOnly = declarationTypeOnly || item.startsWith("type ");
      const name = item.replace(/^type\s+/u, "").trim();
      if (/\s+as\s+/u.test(name)) {
        issues.push(`aliased root export ${name} is not allowed`);
      } else if (
        !(
          itemTypeOnly
            ? ALLOWED_TYPE_ROOT_EXPORTS
            : ALLOWED_RUNTIME_ROOT_EXPORTS
        ).has(name)
      ) {
        issues.push(`root export ${name} is not allowed`);
      }
    }
  }
  return issues;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(absolute)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [absolute]
        : [];
  });
}
