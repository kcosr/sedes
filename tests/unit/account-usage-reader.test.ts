import { describe, expect, it, vi } from "vitest";
import { CompositeAccountUsageReader } from "../../src/server/application/account-usage-reader.js";
import { NO_BACKEND_ACCOUNT_USAGE, type BackendAccountUsageSource } from "../../src/server/backends/backend-account-usage.js";
import type { BackendModuleRuntime } from "../../src/server/backends/module.js";
import type { BackendAccountUsage } from "../../src/shared/protocol/account-usage.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const usage: BackendAccountUsage = {
  capturedAt: 1_000, accountId: "account", plan: "Pro", includedUsageAllowed: true,
  windows: [{ remainingPercent: 25, durationMinutes: 10_080, resetsAt: 10_000 }],
};
function source() {
  let current: BackendAccountUsage | null = usage;
  const listeners = new Set<() => void>();
  return {
    supported: true,
    close: () => undefined,
    snapshot: vi.fn(() => current),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    replace(value: BackendAccountUsage | null) { current = value; for (const listener of listeners) listener(); },
  };
}
function runtime(id: string, accountUsage: BackendAccountUsageSource): Pick<BackendModuleRuntime, "scope" | "instance" | "accountUsage"> {
  return {
    scope, accountUsage,
    instance: { id, tenantId: scope.tenantId, kind: "codex_app_server", label: id, enabled: true, configurationRevision: 1, protocolRelease: "0.169.0" },
  };
}

describe("scoped account usage reader", () => {
  it.each([0, 32, 64])("accepts 64 configured runtimes with %i supported quota sources", supportedCount => {
    const runtimes = new Map(Array.from({ length: 64 }, (_, index) => {
      const id = `backend-${index}`;
      return [id, runtime(id, index < supportedCount ? source() : NO_BACKEND_ACCOUNT_USAGE)] as const;
    }));
    const reader = new CompositeAccountUsageReader({ scope, runtimes, environmentId: () => "host" });
    expect(reader.read(scope)).toHaveLength(supportedCount);
  });

  it("rejects a 65th configured runtime, including an unsupported quota source", () => {
    const runtimes = new Map(Array.from({ length: 65 }, (_, index) => {
      const id = `backend-${index}`;
      return [id, runtime(id, NO_BACKEND_ACCOUNT_USAGE)] as const;
    }));
    expect(() => new CompositeAccountUsageReader({ scope, runtimes, environmentId: () => "host" }))
      .toThrow("too_many_account_usage_sources");
  });

  it("keeps backend and environment ownership separate and omits unavailable or unsupported sources", () => {
    const first = source(), second = source();
    second.replace({ ...usage, accountId: "another-account", windows: [{ remainingPercent: 0, durationMinutes: null, resetsAt: null }] });
    const reader = new CompositeAccountUsageReader({
      scope, runtimes: new Map([["one", runtime("one", first)], ["two", runtime("two", second)], ["unsupported", runtime("unsupported", NO_BACKEND_ACCOUNT_USAGE)]]),
      environmentId: id => `${id}-host`,
    });
    expect(reader.read(scope)).toEqual([
      { ...usage, backendInstanceId: "one", executionEnvironmentId: "one-host" },
      { ...second.snapshot(), backendInstanceId: "two", executionEnvironmentId: "two-host" },
    ]);
    first.replace(null);
    expect(reader.read(scope).map(value => value.backendInstanceId)).toEqual(["two"]);
  });

  it("rejects wrong-principal reads, subscriptions, and runtime replacement", () => {
    const entry = runtime("one", source());
    const reader = new CompositeAccountUsageReader({ scope, runtimes: new Map([["one", entry]]), environmentId: () => "host" });
    const wrong = { ...scope, principalId: "other" };
    expect(() => reader.read(wrong)).toThrow("account_usage_scope_mismatch");
    expect(() => reader.subscribe(wrong, () => undefined)).toThrow("account_usage_scope_mismatch");
    expect(() => reader.replaceRuntimes(scope, new Map([["one", { ...entry, scope: wrong }]]))).toThrow("account_usage_scope_mismatch");
    expect(reader.read(scope)).toHaveLength(1);
  });

  it("moves subscriptions to replacement runtimes and detaches on disposal", () => {
    const first = source(), second = source(), listener = vi.fn();
    let environmentId = "host";
    const reader = new CompositeAccountUsageReader({ scope, runtimes: new Map([["one", runtime("one", first)]]), environmentId: () => environmentId });
    const unsubscribe = reader.subscribe(scope, listener);
    expect(reader.read(scope)[0]?.executionEnvironmentId).toBe("host");
    environmentId = "replacement-host";
    expect(reader.read(scope)[0]?.executionEnvironmentId).toBe("host");
    first.replace(null);
    expect(listener).toHaveBeenCalledTimes(1);
    reader.replaceRuntimes(scope, new Map([["one", runtime("one", second)]]));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reader.read(scope)[0]?.executionEnvironmentId).toBe("replacement-host");
    first.replace(usage);
    expect(listener).toHaveBeenCalledTimes(2);
    second.replace(null);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    second.replace(usage);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
