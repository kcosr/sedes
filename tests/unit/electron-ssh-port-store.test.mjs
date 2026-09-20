import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SshPortStore } from "../../packages/electron-connection-runtime/electron/dist/ssh-port-store.mjs";
const input = { connectionId: "10000000-0000-4000-8000-000000000001", profileId: "20000000-0000-4000-8000-000000000002", hostAlias: "host", remotePort: 4784 };
describe("saved SSH origin", () => {
  it("survives restart, fails closed on conflicts, and never reuses another target's port", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-ssh-ports-"));
    try {
      expect(await new SshPortStore(directory, async () => 31001).portFor(input)).toBe(31001);
      const reserve = vi.fn(async port => port);
      expect(await new SshPortStore(directory, reserve).portFor({ ...input, connectionId: "30000000-0000-4000-8000-000000000003" })).toBe(31001);
      expect(reserve).toHaveBeenCalledExactlyOnceWith(31001);
      const blocked = vi.fn(async () => { throw new Error("occupied"); });
      await expect(new SshPortStore(directory, blocked).portFor(input)).rejects.toMatchObject({ code: "ssh_forward_unavailable" });
      expect(blocked).toHaveBeenCalledExactlyOnceWith(31001);
      const fresh = vi.fn().mockResolvedValueOnce(31001).mockResolvedValueOnce(31002);
      expect(await new SshPortStore(directory, fresh).portFor({ ...input, hostAlias: "different" })).toBe(31002);
      expect(await new SshPortStore(directory, async port => port).portFor(input)).toBe(31001);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
