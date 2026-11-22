import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readAntigravityNativeHistory } from "../../src/server/backends/antigravity/native-history.js";
import { projectAntigravityHistory } from "../../src/server/backends/antigravity/history.js";
import type { AntigravityBinding } from "../../src/server/backends/antigravity/binding.js";

interface FixtureHistory {
  begin(text: string): number;
  response(index: number, text: string): void;
  cancelAtPermission(index: number): void;
  close(): void;
}

it("round-trips the production fixture's cancelled permission tool through the strict native reader", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-antigravity-fixture-history-"));
  const sessionId = randomUUID();
  const { openFixtureHistory } = await import(new URL("../fixtures/antigravity/native-history-fixture.mjs", import.meta.url).href) as {
    openFixtureHistory(geminiDirectory: string, sessionId: string, cwd: string): FixtureHistory;
  };
  const fixture = openFixtureHistory(directory, sessionId, directory);
  try {
    const responseIndex = fixture.begin("Input before a queued Steer.");
    fixture.response(responseIndex, "Waiting for permission.");
    fixture.cancelAtPermission(responseIndex);
    const configuration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend",
      executionEnvironmentId: "environment", geminiDirectory: directory, initializationTimeoutMs: 1000 };
    const { native } = await readAntigravityNativeHistory(configuration, { sessionId, cwd: directory });
    expect(native.steps).toMatchObject([
      { index: 0, user: { text: "Input before a queued Steer." } },
      { index: 1, response: { text: "Waiting for permission.", toolCalls: [{ id: "permission-command", name: "run_command" }] } },
      { index: 2, type: 132, status: 6, tool: { id: "permission-command", name: "run_command" },
        command: { command: "printf permission-check", cwd: directory, persistent: false } },
    ]);
    expect(native.executions).toEqual([{ executionId: native.steps[0]!.executionId, lastStepIndex: 2,
      terminationReason: 2, proceededWithAutoContinue: false }]);
    const binding: AntigravityBinding = { version: 1, sessionId, tenantId: configuration.tenantId, principalId: configuration.principalId,
      backendInstanceId: configuration.backendInstanceId, executionEnvironmentId: configuration.executionEnvironmentId,
      connectionProfileId: "connection", canonicalWorkspacePath: directory, nativeNamespaceKey: "fixture" };
    const { snapshot } = projectAntigravityHistory(native, { binding, key: Buffer.alloc(32, 1) });
    expect(snapshot.runState).toBe("idle");
    expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
    expect(snapshot.itemsById["step:2:command"]).toMatchObject({ status: "interrupted", semanticKind: "command" });
  } finally {
    fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
