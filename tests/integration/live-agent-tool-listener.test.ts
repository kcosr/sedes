import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startLiveAgentToolListener } from "../helpers/live-agent-tool-listener.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { executionPolicyRoots } from "../../src/server/configuration-admin/configuration-execution-policy.js";

describe("live agent-tool fixture workspace admission", () => {
  it("admits the real root grant for media tools and retains the production revocation fence", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sedes-live-tool-fixture-")));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const imagePath = path.join(workspace, "shown.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/i8AAAAASUVORK5CYII=", "base64"));
    const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
    let listener: Awaited<ReturnType<typeof startLiveAgentToolListener>> | undefined;
    try {
      listener = await startLiveAgentToolListener({
        root, workspace, environmentId, targetId: "claude-local", pages: true, imageSourceFiles: [imagePath],
        presentation: { surface: "native", mode: "individual" }, enabledToolIds: ["page.publish", "image.show"],
        configuration: {
          executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: [root, workspace], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated", "execution_host"] } }],
          backends: [{ id: "claude-primary", kind: "claude_agent_sdk", label: "Claude", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: { initializationTimeoutMs: 20000, permissionPolicy: { allowedModes: ["default"] } } }],
          targets: [{ id: "claude-local", kind: "claude_agent_sdk", label: "Claude", backendInstanceId: "claude-primary", executionEnvironmentId: environmentId, enabled: true, moduleConfiguration: { defaults: { permissionMode: "default" } } }],
          defaultTargetId: "claude-local", webSearch: null,
        },
      });
      const f = listener;
      const inventory = f.pages!.dependencies.inventory;
      const admitted = inventory.getWorkspace(f.scope, f.workspaceId);
      const database = openOverlayDatabaseConnection(path.join(root, "state", "overlay.sqlite"));
      try {
        const grant = executionPolicyRoots(database, f.scope, environmentId).find(candidate => candidate.path === workspace)!;
        expect(admitted.authorityRootId).toBe(grant.id);
        expect(admitted.environmentConfigurationRevision).toBe(grant.generation);
        expect(inventory.workspaceAuthorityIsCurrent(f.scope, admitted)).toBe(true);
        const invoke = async (toolId: string, input: unknown) => {
          const response = await fetch(`${f.endpoint}/api/agent-tool-invocations`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "live-agent-tool-csrf", [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: f.issue("mcp") },
            body: JSON.stringify({ requestId: randomUUID(), toolId, schemaVersion: 1, input }),
          });
          expect(response.status).toBe(200);
          return response.json();
        };
        expect(await invoke("page.publish", { title: "Offline fixture page", html: "<p>Validated root</p>" })).toMatchObject({ state: "completed" });
        expect(await invoke("image.show", { path: imagePath, title: "Offline fixture image" })).toMatchObject({ state: "completed" });
        expect(f.imagePublications()).toHaveLength(1);
        database.prepare("UPDATE workspaces SET authority_root_id = NULL WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?")
          .run(f.scope.tenantId, f.scope.principalId, f.workspaceId);
        await expect(f.pages!.prepare(f.scope, f.threadId, { html: "<p>Revoked root</p>" })).rejects.toMatchObject({ code: "conflict" });
      } finally { database.close(); }
    } finally {
      await listener?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
