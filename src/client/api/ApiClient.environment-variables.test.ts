// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { emptyEnvironmentVariablesSnapshot } from "../../shared/protocol/environment-variables.js";

afterEach(() => vi.unstubAllGlobals());
describe("ApiClient environment variables", () => {
  it("requests preview revisions and only receives secret references", async () => {
    const snapshot = emptyEnvironmentVariablesSnapshot();
    snapshot.layers.environment.API_KEY = { kind: "secret", source: { kind: "environment", name: "BUILD_API_KEY" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot, revision: { configurationRevision: 4, agentRevision: 2 }, startup: { supported: false, reason: "Externally owned process." } }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ApiClient().getEnvironmentVariablePreview({ targetId: "target a", agentId: "11111111-1111-4111-8111-111111111111" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/environment-variables/preview?targetId=target+a&agentId=11111111-1111-4111-8111-111111111111");
    expect(result.revision).toEqual({ configurationRevision: 4, agentRevision: 2 });
    expect(result.snapshot.layers.environment.API_KEY).not.toHaveProperty("value");
  });
  it("rejects a response claiming saved thread variables are editable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot: emptyEnvironmentVariablesSnapshot(), editable: true }), { headers: { "Content-Type": "application/json" } })));
    await expect(new ApiClient().getThreadEnvironmentVariables("thread-a")).rejects.toThrow();
  });
});
