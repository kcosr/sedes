import { describe, expect, it, vi } from "vitest";
import type { BackendCatalog } from "../../src/server/backends/contracts.js";
import { PiCatalogService } from "../../src/server/backends/pi/pi-catalog-service.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

function workspace(
  revision = 1,
  trustState: ValidatedWorkspace["summary"]["trustState"] = "trusted",
): ValidatedWorkspace {
  return {
    canonicalPath: "/work/project",
    authorityRevision: 1,
    summary: {
      id: "workspace",
      environmentId: "environment",
      displayName: "project",
      displayPath: "/work/project",
      availability: "available",
      trustState,
      revision,
    },
  };
}

function catalog(label: string): BackendCatalog {
  return {
    models: [{ provider: "test", id: label, label, inputModalities: ["text"] }],
    commands: [],
    skills: [],
    notices: [],
  };
}

const owner = {
  tenantId: "tenant",
  ownerPrincipalId: "principal",
  backendInstanceId: "pi",
  backendConfigurationRevision: 1,
  connectionProfileId: "profile",
  connectionConfigurationRevision: 1,
};

describe("PiCatalogService", () => {
  it("shares one result and one in-flight load for an exact workspace identity", async () => {
    let resolve!: (value: BackendCatalog) => void;
    const pending = new Promise<BackendCatalog>((accept) => {
      resolve = accept;
    });
    const load = vi.fn(() => pending);
    const service = new PiCatalogService({ owner });

    const first = service.read(workspace(), load);
    const second = service.read(workspace(), load);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(catalog("one"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      catalog("one"),
      catalog("one"),
    ]);
    await expect(service.read(workspace(), load)).resolves.toEqual(
      catalog("one"),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys trust and workspace revisions and refreshes after its freshness bound", async () => {
    let now = 1_000;
    const load = vi
      .fn<() => Promise<BackendCatalog>>()
      .mockResolvedValueOnce(catalog("first"))
      .mockResolvedValueOnce(catalog("revision"))
      .mockResolvedValueOnce(catalog("trust"))
      .mockResolvedValueOnce(catalog("expired"));
    const service = new PiCatalogService({
      owner,
      freshnessMilliseconds: 100,
      now: () => now,
    });

    await expect(service.read(workspace(), load)).resolves.toEqual(
      catalog("first"),
    );
    await expect(service.read(workspace(2), load)).resolves.toEqual(
      catalog("revision"),
    );
    await expect(
      service.read(workspace(1, "untrusted"), load),
    ).resolves.toEqual(catalog("trust"));
    now += 101;
    await expect(service.read(workspace(), load)).resolves.toEqual(
      catalog("expired"),
    );
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("serves an expired catalog while refreshing it in the background", async () => {
    let now = 1_000;
    let resolveRefresh!: (value: BackendCatalog) => void;
    const refresh = new Promise<BackendCatalog>((resolve) => {
      resolveRefresh = resolve;
    });
    const load = vi
      .fn<() => Promise<BackendCatalog>>()
      .mockResolvedValueOnce(catalog("first"))
      .mockReturnValueOnce(refresh);
    const service = new PiCatalogService({
      owner,
      freshnessMilliseconds: 100,
      now: () => now,
    });
    await service.read(workspace(), load);
    now += 101;

    await expect(service.read(workspace(), load)).resolves.toEqual(
      catalog("first"),
    );
    expect(load).toHaveBeenCalledTimes(2);
    resolveRefresh(catalog("refreshed"));
    await refresh;
    await expect(service.read(workspace(), load)).resolves.toEqual(
      catalog("refreshed"),
    );
  });

  it("does not deliver or reinstall a catalog invalidated while loading", async () => {
    let resolveFirst!: (value: BackendCatalog) => void;
    const firstLoad = new Promise<BackendCatalog>((accept) => {
      resolveFirst = accept;
    });
    const load = vi
      .fn<() => Promise<BackendCatalog>>()
      .mockReturnValueOnce(firstLoad)
      .mockResolvedValueOnce(catalog("fresh"));
    const target = workspace();
    const service = new PiCatalogService({ owner });

    const staleRead = service.read(target, load);
    service.invalidate(target);
    resolveFirst(catalog("stale"));
    await expect(staleRead).resolves.toEqual(catalog("fresh"));
    await expect(service.read(target, load)).resolves.toEqual(catalog("fresh"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
