import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { AntigravityProductionFixture } from "../support/antigravity-production-fixture.js";
import { parseAntigravityBinding } from "../../src/server/backends/antigravity/binding.js";
import { gate } from "./qualification.js";
import { removeAntigravityQualificationSession } from "./session-cleanup.js";

for (const topology of ["local", "ssh"] as const) {
it.skipIf(topology === "ssh" && process.env.SEDES_LIVE_ANTIGRAVITY_SSH !== "1").each(["native", "cli"] as const)(
  `qualifies scoped %s Sedes tools through the ${topology} stock CLI and production application`, async surface => {
  const selected = gate();
  const f = await AntigravityProductionFixture.create({ topology, executablePath: selected.executablePath, geminiDirectory: selected.geminiDirectory,
    defaults: { modelId: selected.modelId, thinkingLevel: selected.thinkingLevel, modeId: "auto" } });
  try {
    const policy = await f.json("/api/tool-policies", "POST", { name: "Read this test thread", enabledToolIds: ["thread.status"],
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } }) as { policySet: { id: string } };
    const threadId = await f.createThread({ toolPolicySelection: { kind: "policy_set", policySetId: policy.policySet.id },
      toolPresentation: { surface, mode: "progressive" } });
    await f.openStream(threadId);
    const command = await f.toolCommand(threadId);
    if (topology === "ssh") {
      const status = await f.serviceStatus();
      expect(status).toMatchObject({ state: "ready", attached: true, scope: f.serviceScope });
      expect(status?.resources.some(resource => resource.kind === "provider")).toBe(true);
      expect(command).toContain(`${f.hostHome}/.local/state/sedes/sidecar/artifacts/sha256/`);
    }
    const prompt = surface === "native"
      ? `This is a bounded Sedes integration test. Call the Sedes MCP sedes_read tool exactly once with toolId thread.status, schemaVersion 5, input ${JSON.stringify({ threadId })}. Do not run shell commands or use any other tools. Report the backend field returned by this tool, then say SEDES_TOOL_OK.`
      : `This is a bounded Sedes integration test. Run exactly this one read-only command in the current temporary workspace: ${command}\nDo not run other commands or tools. Report the backend field returned, then say SEDES_TOOL_OK.`;
    expect(["delivery_accepted", "delivery_queued"]).toContain((await f.send(threadId, prompt) as { status: string }).status);
    const deadline = Date.now() + 90_000;
    let snapshot = await f.thread(threadId);
    while (Date.now() < deadline) {
      snapshot = await f.thread(threadId);
      for (const interaction of snapshot.interactions) {
        if (interaction.kind !== "decision" || !(surface === "native" ? interaction.title.text.includes("sedes_read") : interaction.title.text === command))
          throw new Error(`LIVE_ANTIGRAVITY_BLOCKER: permission outside the scoped read-only tool test: ${interaction.title.text}`);
        const allow = interaction.actions.find(action => action.role === "primary");
        if (!allow) throw new Error("LIVE_ANTIGRAVITY_BLOCKER: no one-time tool approval");
        await f.json(`/api/threads/${threadId}/operations`, "POST", { kind: "respond", operationId: randomUUID(),
          interactionId: interaction.id, response: { kind: "decision", selectedActionId: allow.id } });
      }

      if (snapshot.runState === "idle" && snapshot.orderedTurnIds.length) break;
      await delay(100);
    }
    expect(f.streamErrors).toEqual([]);
    expect(snapshot.runState).toBe("idle");
    const items = Object.values(snapshot.itemsById);
    const serialized = JSON.stringify(items);
    expect(serialized).toContain("SEDES_TOOL_OK");
    // A model's assertion alone is not proof of tool integration: require the
    // persisted native result to contain the exact thread identity and backend.
    const evidence = items.filter(item => surface === "native" ? item.kind === "tool" : item.kind === "command");
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some(item => {
      const value = JSON.stringify(item);
      return value.includes(threadId) && /\\?"backend\\?"\s*:\s*\\?"antigravity\\?"/u.test(value);
    })).toBe(true);
    if (surface === "cli") expect(evidence.every(item => item.kind !== "command" || item.command.text === command)).toBe(true);
    if (topology === "ssh") {
      // Native history can settle before the terminal ACP receipt reaches main.
      // Retiring an MCP session requires both quiet work and drained receipts.
      await expect.poll(async () => {
        const status = await f.serviceStatus();
        const providers = status?.resources.filter(resource => resource.kind === "provider") ?? [];
        return status?.state === "ready" && status.attached && providers.length > 0 &&
          providers.every(resource => resource.state === "idle" && resource.blockers.length === 0);
      }, { timeout: 10_000 }).toBe(true);
    }
    const policyBefore = snapshot.agentTools;
    await f.json(`/api/threads/${threadId}/operations`, "POST", { kind: "set_agent_tool_policy", mutationId: randomUUID(),
      expectedPolicyRevision: policyBefore.revision, enabled: false, enabledToolIds: [],
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false }, presentation: { surface, mode: "progressive" } });
    expect((await f.thread(threadId)).agentTools.enabled).toBe(false);
  } finally {
    const database = new Database(path.join(f.directory, "main", "overlay.sqlite"), { readonly: true });
    const bindings = database.prepare("SELECT opaque_binding_detail FROM antigravity_binding_details").all() as { opaque_binding_detail: string }[];
    database.close();
    await f.close(async () => {
      for (const row of bindings) {
        const binding = parseAntigravityBinding(row.opaque_binding_detail);
        await removeAntigravityQualificationSession({ ...binding, executablePath: selected.executablePath, geminiDirectory: selected.geminiDirectory,
          initializationTimeoutMs: 30_000 }, { sessionId: binding.sessionId, cwd: binding.canonicalWorkspacePath }, f.directory);
      }
    });
  }
});
}
