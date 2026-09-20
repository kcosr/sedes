import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveAgentToolCliEndpointKey,
  deriveComposerAttachmentScopeKey,
  deriveLineageCursorSigningKey,
  deriveSidecarInstallationIdentity,
  loadOrCreateToolProvenanceKey,
} from "../../src/server/security/installation-secret.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "sedes-key-"));
  roots.push(created);
  return created;
}

describe("loadOrCreateToolProvenanceKey", () => {
  it("preserves the public sidecar identity across restart and separates installations", async () => {
    const stateDirectory = await root();
    const key = await loadOrCreateToolProvenanceKey(stateDirectory);
    const identity = deriveSidecarInstallationIdentity(key);
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      deriveSidecarInstallationIdentity(
        await loadOrCreateToolProvenanceKey(stateDirectory),
      ),
    ).toBe(identity);
    expect(
      deriveSidecarInstallationIdentity(
        await loadOrCreateToolProvenanceKey(await root()),
      ),
    ).not.toBe(identity);
    expect(identity).not.toBe(Buffer.from(key).toString("hex"));
    expect(identity).not.toBe(
      Buffer.from(deriveLineageCursorSigningKey(key)).toString("hex"),
    );
    expect(() => deriveSidecarInstallationIdentity(new Uint8Array(31))).toThrow(
      "installation_secret_invalid",
    );
  });

  it("derives a stable, domain-separated descendant cursor key", () => {
    const installationKey = new Uint8Array(32).fill(17);
    const first = deriveLineageCursorSigningKey(installationKey);
    const afterRestart = deriveLineageCursorSigningKey(installationKey);

    expect(first).toEqual(afterRestart);
    expect(Buffer.from(first).toString("hex")).toBe(
      "d305e2cebb7657393b6c06db925577ba525f83b0e46b34a3456b6e364aadc88a",
    );
    expect(first).toHaveLength(32);
    expect(first).not.toEqual(installationKey);
    expect(() => deriveLineageCursorSigningKey(new Uint8Array(31))).toThrow(
      "installation_secret_invalid",
    );
  });

  it("derives a stable environment-scoped agent-tool endpoint key", () => {
    const installationKey = new Uint8Array(32).fill(17);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const first = deriveAgentToolCliEndpointKey(
      installationKey,
      scope,
      "environment-a",
    );

    expect(first).toMatch(/^[0-9a-f]{24}$/u);
    expect(first).toBe("cc3610cf2103fa627a339cbe");
    expect(
      deriveAgentToolCliEndpointKey(installationKey, scope, "environment-a"),
    ).toBe(first);
    expect(
      deriveAgentToolCliEndpointKey(installationKey, scope, "environment-b"),
    ).not.toBe(first);
    expect(() =>
      deriveAgentToolCliEndpointKey(new Uint8Array(31), scope, "environment-a"),
    ).toThrow("installation_secret_invalid");
  });

  it("keeps the persisted attachment scope namespace stable", () => {
    expect(
      deriveComposerAttachmentScopeKey(new Uint8Array(32).fill(17), {
        tenantId: "tenant",
        principalId: "principal",
      }),
    ).toBe("208c8ce18207025ed1f8ab016e336941a4483ce421363e65af755f9965d05a2b");
  });

  it("creates one private persistent 256-bit key", async () => {
    const stateDirectory = await root();
    const first = await loadOrCreateToolProvenanceKey(stateDirectory);
    const second = await loadOrCreateToolProvenanceKey(stateDirectory);

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(
      (
        await readFile(
          path.join(stateDirectory, ".tool-provenance-key"),
          "utf8",
        )
      ).trim(),
    ).toHaveLength(43);
    expect(
      (await readdir(stateDirectory)).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("installs one key atomically across concurrent creators", async () => {
    const stateDirectory = await root();
    const keys = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadOrCreateToolProvenanceKey(stateDirectory),
      ),
    );
    expect(keys.every((key) => Buffer.from(key).equals(keys[0]!))).toBe(true);
    expect(
      (await readdir(stateDirectory)).filter((name) => name.includes(".tmp-")),
    ).toEqual([]);
  });

  it("does not promote an interrupted temporary write", async () => {
    const stateDirectory = await root();
    await writeFile(
      path.join(stateDirectory, ".tool-provenance-key.tmp-interrupted"),
      "partial",
      { mode: 0o600 },
    );

    const key = await loadOrCreateToolProvenanceKey(stateDirectory);
    expect(key).toHaveLength(32);
    expect(
      await readFile(path.join(stateDirectory, ".tool-provenance-key"), "utf8"),
    ).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an exposed or symlinked key",
    async () => {
      const exposedDirectory = await root();
      await loadOrCreateToolProvenanceKey(exposedDirectory);
      await chmod(path.join(exposedDirectory, ".tool-provenance-key"), 0o644);
      await expect(
        loadOrCreateToolProvenanceKey(exposedDirectory),
      ).rejects.toThrow("installation_secret_permissions_invalid");

      const linkedDirectory = await root();
      await symlink(
        path.join(exposedDirectory, ".tool-provenance-key"),
        path.join(linkedDirectory, ".tool-provenance-key"),
      );
      await expect(
        loadOrCreateToolProvenanceKey(linkedDirectory),
      ).rejects.toMatchObject({ code: "ELOOP" });
    },
  );
});
