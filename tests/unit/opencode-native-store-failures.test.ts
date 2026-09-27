import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeNativeStoreLifecycle } from "../../src/server/backends/opencode/opencode-native-store.js";

const faults = vi.hoisted(() => ({ next: "" as "" | "open" | "write" | "sync" | "directory_sync" | "metadata" | "replace" | "remnant" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const failed = () => Object.assign(new Error("synthetic filesystem failure"), { code: "EIO" });
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (faults.next === "metadata" && String(args[0]).endsWith(".lock")) {
        faults.next = ""; throw failed();
      }
      return await actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.next === "directory_sync" && String(args[0]).endsWith(".lock")) {
        faults.next = ""; const descriptor = await actual.open(...args);
        descriptor.sync = async () => { throw failed(); }; return descriptor;
      }
      if (!String(args[0]).endsWith("/owner.json") || args[1] !== "wx") return await actual.open(...args);
      const fault = faults.next; if (fault !== "directory_sync") faults.next = "";
      if (fault === "open") throw failed();
      const descriptor = await actual.open(...args);
      const write = descriptor.writeFile.bind(descriptor);
      if (["write", "replace", "remnant"].includes(fault)) {
        descriptor.writeFile = async (data) => {
          await write(String(data).slice(0, 9));
          const directory = path.dirname(String(args[0]));
          if (fault === "replace") {
            await actual.rename(directory, `${directory}.displaced`);
            await actual.mkdir(directory, { mode: 0o700 });
            await actual.writeFile(path.join(directory, "do-not-delete"), "replacement canary");
          }
          if (fault === "remnant") await actual.writeFile(path.join(directory, "do-not-delete"), "unknown canary");
          throw failed();
        };
      }
      if (fault === "sync") descriptor.sync = async () => { throw failed(); };
      return descriptor;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  faults.next = "";
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-lock-failure-")); roots.push(root);
  return { root, lifecycle: createOpenCodeNativeStoreLifecycle({ canonicalStorePath: path.join(root, "opencode.db"), label: "fixture", ownership: "owned", hostIncarnation: "fixture-host" }) };
}

describe.skipIf(process.platform !== "linux")("OpenCode store ownership initialization rollback", () => {
  it.each(["open", "write", "sync", "directory_sync"] as const)("rolls back proved %s failure before any native owner exists", async fault => {
    const { root, lifecycle } = await fixture(); faults.next = fault;
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_owner_write_failed");
    expect(await readdir(root)).toEqual([]);
    const lease = await lifecycle.acquire(); await lease.release();
    expect(await readdir(root)).toEqual([]);
  });
  it("retains the fence if the newly created directory identity cannot be observed", async () => {
    const { root, lifecycle } = await fixture(); faults.next = "metadata";
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_initialization_unproved");
    expect((await readdir(root)).filter(name => name.endsWith(".lock"))).toHaveLength(1);
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_recovery_required");
  });
  it.each(["replace", "remnant"] as const)("preserves unproved %s evidence instead of deleting it", async fault => {
    const { root, lifecycle } = await fixture(); faults.next = fault;
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_initialization_unproved");
    const lock = (await readdir(root)).find(name => name.endsWith(".lock"))!;
    expect(await readFile(path.join(root, lock, "do-not-delete"), "utf8")).toContain("canary");
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_recovery_required");
  });
});
