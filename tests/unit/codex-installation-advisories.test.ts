import { describe, expect, it, vi } from "vitest";
import { CodexInstallationAdvisorySource } from "../../src/server/backends/codex/codex-installation-advisories.js";

describe("CodexInstallationAdvisorySource", () => {
  it("publishes only a newer-than-tested runtime assessment", () => {
    const source = new CodexInstallationAdvisorySource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source.observe({ version: "0.153.0+vendor.1", newerThanTested: false });
    expect(source.active()).toEqual([]);

    source.observe({ version: "0.155.0", newerThanTested: true });
    expect(source.active()).toEqual([
      {
        id: "runtime-newer-than-tested",
        tone: "warning",
        title: { text: "Codex is newer than tested" },
        message: {
          text: "Running 0.155.0; Sedes is tested through 0.154.0.",
        },
      },
    ]);

    source.observe({ version: "0.153.0", newerThanTested: false });
    expect(source.active()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    source.clear();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("deduplicates an unchanged assessment", () => {
    const source = new CodexInstallationAdvisorySource();
    const listener = vi.fn();
    source.subscribe(listener);

    source.observe({ version: "0.155.0", newerThanTested: true });
    source.observe({ version: "0.155.0", newerThanTested: true });

    expect(listener).toHaveBeenCalledOnce();
  });
});
