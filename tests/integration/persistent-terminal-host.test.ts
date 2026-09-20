import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistentTerminalHost } from "../../src/server/sidecar/persistent-terminal-host.js";
import { RemoteInteractiveTerminalProcess } from "../../src/server/execution/ssh-interactive-terminal-provider.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { terminalPrepareOperation, terminalCreateOperation } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import type { InteractiveTerminalExit } from "../../src/server/execution/interactive-terminal.js";
import { registryCaller, terminalTestScope } from "../helpers/persistent-terminal-fixture.js";

describe.skipIf(process.platform === "win32")("persistent execution-host PTY", () => {
  it("keeps the real shell PID and screen through attachment replacement and hands final output to main", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-remote-pty-"));
    const host = new PersistentTerminalHost({
      scope: terminalTestScope, environmentId: "remote",
      environment: { HOME: directory, PATH: process.env.PATH, SHELL: "/bin/bash", LANG: "C.UTF-8" },
    });
    const registry = new SidecarOperationRegistry();
    host.registerOperations(registry, { assertAdmission() {}, assertController() {} });
    const caller = registryCaller(registry);
    const identity = { terminalId: randomUUID(), incarnationId: randomUUID() };
    let terminal: RemoteInteractiveTerminalProcess | undefined;
    let shellPid: number | undefined;
    const outputs: string[] = [];
    const restores: string[] = [];
    const exits: InteractiveTerminalExit[] = [];
    try {
      await caller.call(terminalCreateOperation, await caller.call(terminalPrepareOperation, {
        ...identity, initialCwd: directory, rows: 24, columns: 80,
      }));
      terminal = await RemoteInteractiveTerminalProcess.attach(caller, identity);
      terminal.onOutput((bytes) => outputs.push(Buffer.from(bytes).toString()));
      await terminal.persistent.start({ restore: async ({ bytes }) => { restores.push(Buffer.from(bytes).toString()); }, resize: async () => undefined, unavailable() {} });
      await terminal.write(Buffer.from("printf 'SEDES_TEST_PID=%s\\n' \"$$\"\r"));
      await vi.waitFor(() => expect(outputs.join("")).toMatch(/SEDES_TEST_PID=\d+/u), { timeout: 5000 });
      shellPid = Number(/SEDES_TEST_PID=(\d+)/u.exec(outputs.join(""))![1]);
      const firstPid = shellPid;
      await terminal.persistent.detach();
      host.onDetach();
      expect(() => process.kill(firstPid, 0)).not.toThrow();

      terminal = await RemoteInteractiveTerminalProcess.attach(caller, identity);
      terminal.onOutput((bytes) => outputs.push(Buffer.from(bytes).toString()));
      terminal.onExit((exit) => exits.push(exit));
      await terminal.persistent.start({ restore: async ({ bytes }) => { restores.push(Buffer.from(bytes).toString()); }, resize: async () => undefined, unavailable() {} });
      expect(restores.at(-1)).toContain(`SEDES_TEST_PID=${firstPid}`);
      await terminal.write(Buffer.from("printf 'SEDES_RESUMED_PID=%s\\n' \"$$\"\r"));
      await vi.waitFor(() => expect(outputs.join("")).toContain(`SEDES_RESUMED_PID=${firstPid}`));
      await terminal.write(Buffer.from("printf 'FINAL_PTY_OUTPUT\\n'; exit\r"));
      await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5000 });
      expect(outputs.join("")).toContain("FINAL_PTY_OUTPUT");
      expect(exits[0]).toMatchObject({ disposition: "exited", exitCode: 0, cleanupConfirmed: true });
      expect(host.snapshot().blockers).toEqual(["unsettled_outcome"]);
      await terminal.persistent.acknowledgeFinal();
      expect(host.snapshot().blockers).toEqual([]);
      await terminal.persistent.forget();
      expect(() => process.kill(firstPid, 0)).toThrow();
      shellPid = undefined;
    } finally {
      await terminal?.terminate("kill").catch(() => undefined);
      await terminal?.persistent.detach();
      if (shellPid) { try { process.kill(-shellPid, "SIGKILL"); } catch { /* already exited */ } }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
