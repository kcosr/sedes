import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const sharedTransportFiles = [
  "src/server/provider-protocol/transport/assured-framed-transport.ts",
  "src/server/provider-protocol/transport/owned-ndjson-stdio-transport.ts",
  "src/server/provider-protocol/transport/websocket-framed-connection.ts",
] as const;

describe("provider protocol transport boundary", () => {
  it("keeps backend semantics, launch policy, and provider identities out of shared transport", async () => {
    const sources = await Promise.all(
      sharedTransportFiles.map(async (filename) => ({
        filename,
        source: await readFile(path.join(repositoryRoot, filename), "utf8"),
      })),
    );

    for (const { filename, source } of sources) {
      expect(source, filename).not.toMatch(
        /(?:from\s+["'][^"']*\/backends\/|shared\/protocol)/u,
      );
      expect(source, filename).not.toMatch(
        /\b(?:Codex|codex|ACP|acp|Grok|grok|conversation)\b/u,
      );
      expect(source, filename).not.toMatch(
        /(?:sqlite_home|CODEX_HOME|app-server|capability_token|x\.ai\/)/u,
      );
    }
  });

  it("cuts Codex over directly with no legacy transport implementation or re-export bridge", async () => {
    for (const filename of [
      "src/server/backends/codex/transport/framed-message-transport.ts",
      "src/server/backends/codex/transport/websocket-framed-connection.ts",
    ]) {
      await expect(
        access(path.join(repositoryRoot, filename)),
      ).rejects.toThrow();
    }

    const rpcSource = await readFile(
      path.join(
        repositoryRoot,
        "src/server/backends/codex/rpc/codex-rpc-client.ts",
      ),
      "utf8",
    );
    expect(rpcSource).toContain(
      "provider-protocol/transport/assured-framed-transport.js",
    );
    expect(rpcSource).not.toContain("transport/framed-message-transport.js");

    const ownedWrapper = await readFile(
      path.join(
        repositoryRoot,
        "src/server/backends/codex/transport/owned-stdio-transport.ts",
      ),
      "utf8",
    );
    expect(ownedWrapper).toContain("buildOwnedStdioAppServerArguments");
    expect(ownedWrapper).toContain("OwnedNdjsonStdioTransportFactory");
    expect(ownedWrapper).toContain(
      'transportDiagnosticPrefix: "codex_owned_stdio"',
    );
    expect(ownedWrapper).not.toMatch(/export\s+\*\s+from/u);
  });

  it("keeps Grok on the shared carrier and ACP resource policy", async () => {
    const [ownedWrapper, acpConnection] = await Promise.all([
      readFile(
        path.join(
          repositoryRoot,
          "src/server/backends/grok/grok-owned-stdio-transport.ts",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          repositoryRoot,
          "src/server/backends/grok/grok-acp-connection.ts",
        ),
        "utf8",
      ),
    ]);

    expect(ownedWrapper).toContain("OwnedNdjsonStdioTransportFactory");
    expect(ownedWrapper).not.toMatch(/\blimits\s*:/u);
    expect(ownedWrapper).not.toContain("maximumInboundQueueFrames");
    expect(ownedWrapper).not.toContain("maximumOutboundQueueFrames");

    expect(acpConnection).toContain("new AcpBinding");
    expect(acpConnection).not.toMatch(/\blimits\s*:/u);
    expect(acpConnection).not.toContain("MAXIMUM_PROVIDER_FRAME_BYTES");
  });
});
