import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  effectiveGrokNativeHome,
  grokNativeNamespaceKey,
} from "../../src/server/backends/grok/grok-native-namespace.js";
import { GrokOwnedStdioTransportFactory } from "../../src/server/backends/grok/grok-owned-stdio-transport.js";
import { projectGrokLatestHistoryWithGeneratedImages } from "../../src/server/backends/grok/grok-normalized-history.js";
import { resolveGrokWorkspaceRuntimeConfiguration } from "../../src/server/backends/grok/grok-runtime-config.js";
import { GrokSessionLifecycle } from "../../src/server/backends/grok/grok-session-lifecycle.js";
import { GrokSessionRegistry } from "../../src/server/backends/grok/grok-session-registry.js";
import { grokSubmissionPromptId } from "../../src/server/backends/grok/grok-submission-correlation.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

const LIVE_GATE = "SEDES_REAL_GROK";
const OUTPUT_LIVE_GATE = "SEDES_REAL_GROK_GENERATED_IMAGE";
const EXECUTABLE_OVERRIDE = "SEDES_REAL_GROK_EXECUTABLE";
const roots: string[] = [];
const scope = Object.freeze({
  tenantId: "real-grok-output-tenant",
  principalId: "real-grok-output-principal",
});
const backendInstanceId = "real-grok-output-instance";
const connectionProfileId = "real-grok-output-connection";
const executionEnvironmentId = "real-grok-output-environment";

afterAll(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.env[OUTPUT_LIVE_GATE] !== "1")(
  "real Grok generated image output",
  () => {
    it("publishes one ImageGen JPEG through normalized artifact history", async () => {
      const executablePath = await requireLiveExecutable();
      const root = await mkdtemp(
        path.join(os.tmpdir(), "sedes-real-grok-output-"),
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
        () => controller.abort(new Error("real_grok_output_deadline_exceeded")),
        210_000,
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
        const factory = new GrokOwnedStdioTransportFactory({
          runtime,
          channels,
        });
        lifecycle = await GrokSessionLifecycle.open({
          transport: await factory.open(1, controller.signal),
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
        const nativeNamespaceKey = grokNativeNamespaceKey(
          executionEnvironmentId,
          environment,
        );
        const correlation = {
          installationKey: new Uint8Array(32).fill(0x49),
          ...scope,
          backendInstanceId,
          connectionProfileId,
          executionEnvironmentId,
          nativeNamespaceKey,
          canonicalWorkspacePath: workspace,
          sessionId: created.state.sessionId,
        } as const;
        const promptId = grokSubmissionPromptId({
          ...correlation,
          applicationOperationId: `real-grok-output-${randomUUID()}`,
          reconciliationToken: randomUUID(),
        });
        const operation = lifecycle.startPrompt(
          created.state.sessionId,
          promptId,
          [
            {
              type: "text",
              text: "Call the image_gen tool exactly once to generate a simple solid red square. Do not call any other tool. When it is complete, reply exactly `image-ready`.",
            },
          ],
          { signal: controller.signal },
        );
        await expect(operation.accepted).resolves.toMatchObject({ promptId });
        const completed = await operation.completed;
        expect(completed.response.stopReason).toBe("end_turn");
        const rawImage = completed.history.find(
          (record) =>
            record.kind === "tool" &&
            record.identity.promptId === promptId &&
            record.patch.status === "completed" &&
            isRecord(record.patch.rawOutput) &&
            record.patch.rawOutput.type === "ImageGen",
        );
        expect(rawImage).toBeDefined();

        const stored = createInMemoryOutputArtifactPublisher();
        const publications: Uint8Array[] = [];
        const outputArtifacts = {
          findImage: stored.findImage,
          publishImage: async (
            input: Parameters<typeof stored.publishImage>[0],
          ) => {
            publications.push(input.bytes);
            return await stored.publishImage(input);
          },
        };
        const context = {
          scope,
          applicationThreadId: randomUUID(),
          outputArtifacts,
          authority: {
            nativeHome: effectiveGrokNativeHome(environment),
            canonicalWorkspacePath: workspace,
            sessionId: created.state.sessionId,
          },
        } as const;
        const projected = (
          await projectGrokLatestHistoryWithGeneratedImages(
            completed.history,
            correlation,
            context,
          )
        ).snapshot;
        const artifact = Object.values(projected.itemsById).find(
          (item) =>
            item.semanticKind === "image" &&
            item.image.representation === "artifact",
        );
        expect(artifact).toMatchObject({
          semanticKind: "image",
          image: {
            representation: "artifact",
            mimeType: "image/jpeg",
            byteSize: publications[0]?.byteLength,
          },
        });
        expect(publications).toHaveLength(1);
        const normalized = JSON.stringify(projected);
        if (rawImage?.kind === "tool" && isRecord(rawImage.patch.rawOutput)) {
          expect(normalized).not.toContain(rawImage.patch.rawOutput.path);
        }
        expect(normalized).not.toContain("images/1.jpg");
        await lifecycle.closeSession(created.state.sessionId, {
          signal: controller.signal,
        });
      } finally {
        try {
          await lifecycle?.close("real_grok_output_cleanup");
        } finally {
          clearTimeout(deadline);
          channels.close();
        }
      }
    }, 240_000);
  },
);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
