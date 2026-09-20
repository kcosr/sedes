import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { grokNativeNamespaceKey } from "../../src/server/backends/grok/grok-native-namespace.js";
import { GrokOwnedStdioTransportFactory } from "../../src/server/backends/grok/grok-owned-stdio-transport.js";
import { resolveGrokWorkspaceRuntimeConfiguration } from "../../src/server/backends/grok/grok-runtime-config.js";
import { GrokSessionLifecycle } from "../../src/server/backends/grok/grok-session-lifecycle.js";
import { GrokSessionRegistry } from "../../src/server/backends/grok/grok-session-registry.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const LIVE_GATE = "SEDES_REAL_GROK";
const EXECUTABLE_OVERRIDE = "SEDES_REAL_GROK_EXECUTABLE";
const roots: string[] = [];
const scope = Object.freeze({
  tenantId: "real-grok-image-tenant",
  principalId: "real-grok-image-principal",
});
const backendInstanceId = "real-grok-image-instance";
const executionEnvironmentId = "real-grok-image-environment";

afterAll(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("real Grok user attachment input", () => {
  it("reads one staged file and recognizes one image through standard ACP blocks", async () => {
    const executablePath = await requireLiveExecutable();
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-real-grok-image-"),
    );
    roots.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    const environment = Object.freeze({ ...process.env });
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment,
    });
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error("real_grok_image_deadline_exceeded")),
      180_000,
    );
    let lifecycle: GrokSessionLifecycle | undefined;
    try {
      const runtime = await resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId,
        executionEnvironmentId,
        executablePath,
        canonicalWorkspace: workspace,
        environmentChannel: channels,
        environment,
      });
      const factory = new GrokOwnedStdioTransportFactory({ runtime, channels });
      const transport = await factory.open(1, controller.signal);
      lifecycle = await GrokSessionLifecycle.open({
        transport,
        owner: {
          scope: factory.scope,
          nativeNamespaceKey: grokNativeNamespaceKey(
            executionEnvironmentId,
            environment,
          ),
          workspace,
          connectionGeneration: 1,
          processOwnerId: randomUUID(),
        },
        registry: new GrokSessionRegistry(),
        inlineSessionUpdates: true,
        signal: controller.signal,
      });
      const model = lifecycle.modelCatalog.availableModels.find(
        ({ modelId }) => modelId === lifecycle!.modelCatalog.currentModelId,
      );
      expect(model).toBeDefined();
      const created = await lifecycle.newSession({
        configuration: {
          modelId: model!.modelId,
          ...(model!.defaultReasoningEffort
            ? { reasoningEffort: model!.defaultReasoningEffort }
            : {}),
        },
        signal: controller.signal,
      });
      const promptId = `sedes-grok-live-image-${randomUUID()}`;
      const image = solidRedPng();
      const fileCanary = "sedes-grok-file-canary";
      const stagedFile = path.join(workspace, "attachment.txt");
      await writeFile(stagedFile, fileCanary, "utf8");
      const operation = lifecycle.startPrompt(
        created.state.sessionId,
        promptId,
        [
          {
            type: "text",
            text: `Inspect the attached solid-color square and read the referenced text file. Reply with the lowercase color name and the exact file token ${fileCanary}.`,
          },
          {
            type: "image",
            mimeType: "image/png",
            data: image.toString("base64"),
          },
          {
            type: "resource_link",
            name: "attachment.txt",
            uri: `file://${stagedFile}`,
            mimeType: "text/plain",
            size: Buffer.byteLength(fileCanary),
          },
        ],
        { signal: controller.signal },
      );
      await expect(operation.accepted).resolves.toMatchObject({ promptId });
      const completed = await operation.completed;
      expect(completed.response.stopReason).toBe("end_turn");
      const answer = completed.history
        .flatMap((record) =>
          record.kind === "assistant_text" &&
          record.identity.promptId === promptId
            ? [record.text.text]
            : [],
        )
        .join("")
        .trim()
        .toLowerCase();
      expect(answer).toContain("red");
      expect(answer).toContain(fileCanary);
      await lifecycle.closeSession(created.state.sessionId, {
        signal: controller.signal,
      });
    } finally {
      try {
        await lifecycle?.close("real_grok_image_cleanup");
      } finally {
        clearTimeout(deadline);
        channels.close();
      }
    }
  });
});

async function requireLiveExecutable(): Promise<string> {
  if (process.env[LIVE_GATE] !== "1") {
    throw new Error(`Set ${LIVE_GATE}=1 to authorize the real Grok suite.`);
  }
  const executable = process.env[EXECUTABLE_OVERRIDE];
  if (
    !executable ||
    !path.isAbsolute(executable) ||
    executable.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(executable)
  ) {
    throw new Error(
      `Set ${EXECUTABLE_OVERRIDE} to one canonical absolute path.`,
    );
  }
  const canonical = await realpath(executable);
  if (canonical !== executable) {
    throw new Error(`${EXECUTABLE_OVERRIDE} must already be canonical.`);
  }
  return canonical;
}

function solidRedPng(): Buffer {
  const width = 32;
  const height = 32;
  const row = Buffer.alloc(1 + width * 3);
  for (let offset = 1; offset < row.byteLength; offset += 3) {
    row[offset] = 0xff;
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
