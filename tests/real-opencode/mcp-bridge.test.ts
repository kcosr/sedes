import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { startOpencodeNativeFixture, RUN_REAL_OPENCODE } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
import { OpenCodeMcpIngress } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it.skipIf(!RUN_REAL_OPENCODE)("stock opencode2 invokes the bundled per-call bridge and its child exits after main revocation", async () => {
  const model = await startOpencodeModelFixture();
  const native = await startOpencodeNativeFixture({ config: model.config }).catch(async error => { await model.stop(); throw error; });
  const ingress = new OpenCodeMcpIngress();
  const cleanup = async () => { await ingress.close(); await native.stop(); await model.stop(); };
  cleanups.push(cleanup);
  const observed: string[] = [];
  const canonical = new CanonicalInlineAgentToolService({ application: { readWorkspaceProjectId: async () => "project-1", readThreadStatus: async () => undefined } });
  const channel = await ingress.admit({ catalog: canonical.catalogSummaries("mcp", "thread_agent"),
    invoke: async request => { expect(request.operation).toBe("list"); observed.push(request.sessionID); return { tools: [] }; } });
  try {
    const main = fileURLToPath(new URL("../../dist/cli/sedes-cli-main.js", import.meta.url));
    const pidFile = path.join(native.rootDirectory, "bridge.pid");
    const wrapper = path.join(native.rootDirectory, "bridge.mjs");
    await writeFile(wrapper, `import {writeFile} from 'node:fs/promises';\nawait writeFile(${JSON.stringify(pidFile)},String(process.pid));\nawait import(${JSON.stringify(pathToFileURL(main).href)});\n`);
    const location = `?location[directory]=${encodeURIComponent(native.workspace)}`;
    expect((await native.api("PUT", `/api/experimental/mcp/sedes_probe${location}`, { config: { type: "local", command: [process.execPath, wrapper, "opencode-mcp"],
      environment: channel.environment, codemode: false, protocol: "legacy", timeout: { startup: 10_000, catalog: 10_000, execution: 86_400_000 } } })).status).toBe(204);
    await vi.waitFor(async () => expect((await native.api("GET", `/api/mcp${location}`)).body.data).toContainEqual({ name: "sedes_probe", status: { status: "connected" } }), { timeout: 15_000 });
    const creation = await native.api("POST", "/api/session", { location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" } });
    expect(creation.status).toBe(200); const session = creation.body.data;
    const call = model.callToolNextStream("bridge-call", "sedes_probe_sedes_catalog", { action: "list" });
    const prompt = await native.api("POST", `/api/session/${session.id}/prompt`, { id: "msg_bridge", text: "bridge-call", delivery: "queue", resume: true });
    expect(prompt.status).toBe(200);
    let called = false; void call.called.then(() => { called = true; });
    await vi.waitFor(() => expect(called, JSON.stringify(model.requests)).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(observed).toEqual([session.id]), { timeout: 20_000 });
    expect(model.requests.some(request => request.toolNames.includes("sedes_probe_sedes_catalog"))).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8")); expect(pid).toBeGreaterThan(1);
    channel.revoke();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000, interval: 50 });
  } finally { cleanups.splice(cleanups.indexOf(cleanup), 1); await cleanup(); }
});
