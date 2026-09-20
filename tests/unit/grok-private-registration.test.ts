import { describe, expect, it } from "vitest";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
describe("Grok compiled registration", () => {
  it("registers the reviewed backend and connection kinds exactly once", () => {
    expect(
      compiledBackendModuleCatalog.moduleForBackendKind("grok_build"),
    ).toMatchObject({ backendKind: "grok_build" });
    expect(
      compiledBackendModuleCatalog.moduleForConnectionKind("grok_acp"),
    ).toMatchObject({ backendKind: "grok_build" });
  });
});
