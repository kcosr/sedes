import { describe, expect, it, vi } from "vitest";
import { AntigravityAgentToolService } from "../../src/server/backends/antigravity/agent-tools.js";
import { agentToolPresentationPermitsAdapter, type BackendAgentToolPolicy } from "../../src/server/agent-tools/adapters/backend-facade.js";

const source = { scope: { tenantId: "tenant", principalId: "principal" }, applicationThreadId: "thread", workspaceId: "workspace", executionEnvironmentId: "environment" };
function policy(surface: "native" | "cli", enabled = true): BackendAgentToolPolicy {
  return { enabled, presentation: { surface, mode: "progressive" }, enabledToolIds: ["thread.status"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } };
}
describe("Antigravity Sedes tool authority", () => {
  it.each(["native", "cli"] as const)("binds %s launch authority to the exact principal and source thread", async surface => {
    const issue = vi.fn(() => "scoped-capability");
    const service = new AntigravityAgentToolService({ facade: { readPolicy: () => policy(surface) },
      sourceCapabilities: { issue }, remote: false,
      cli: { availability: "available", endpoint: "http://127.0.0.1:1234", executableDirectory: "/runtime/bin", inheritedPath: "/usr/bin" } });
    expect(await service.prepareLaunch(source)).toEqual({ surface, mode: "progressive", endpoint: "http://127.0.0.1:1234",
      executableDirectory: "/runtime/bin", inheritedPath: "/usr/bin", sourceCapability: "scoped-capability" });
    expect(issue).toHaveBeenCalledWith({ scope: source.scope, sourceThreadId: "thread", sourceWorkspaceId: "workspace", sourceEnvironmentId: "environment", backendKind: "antigravity" }, "management_http", surface === "native" ? "mcp" : "cli");
    expect(agentToolPresentationPermitsAdapter(policy(surface).presentation, "antigravity", surface === "native" ? "mcp" : "cli")).toBe(true);
    expect(agentToolPresentationPermitsAdapter(policy(surface).presentation, "antigravity", "pi_rpc")).toBe(false);
    if (surface === "cli") {
      const instructions = service.instructions(source);
      expect(instructions).toContain("'/runtime/bin/sedes'");
      expect(instructions.match(/PATH=/gu)).toHaveLength(1);
    }
    await service.close();
  });
  it("retains a remote endpoint until the module closes and never replaces it with local HTTP", async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ availability: "available" as const, endpoint: "unix:///tmp/sedes-test.sock", executableDirectory: "/host/bin",
      inheritedPath: "/usr/bin", closed: new Promise(() => undefined), release }));
    const issue = vi.fn(() => "scoped-capability");
    const service = new AntigravityAgentToolService({ facade: { readPolicy: () => policy("native") }, sourceCapabilities: { issue }, remote: true,
      cli: { availability: "managed", provider: { acquire, inspect: () => ({ availability: "available" }) } } });
    await service.prepareLaunch(source); await service.prepareLaunch(source);
    expect(acquire).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith(expect.anything(), "execution_environment_sidecar", "mcp");
    await service.close(); expect(release).toHaveBeenCalledOnce();
    const invalid = new AntigravityAgentToolService({ facade: { readPolicy: () => policy("native") }, sourceCapabilities: { issue }, remote: true,
      cli: { availability: "available", endpoint: "http://127.0.0.1:1234", executableDirectory: "/main/bin", inheritedPath: "/usr/bin" } });
    await expect(invalid.prepareLaunch(source)).rejects.toThrow("endpoint_invalid");
  });
  it("classifies an expired managed CLI lease as safely not dispatched", async () => {
    let expire!: () => void;
    const closed = new Promise<void>(resolve => { expire = resolve; });
    const release = vi.fn();
    const service = new AntigravityAgentToolService({ facade: { readPolicy: () => policy("cli") },
      sourceCapabilities: { issue: () => "scoped-capability" }, remote: true,
      cli: { availability: "managed", provider: { acquire: async () => ({ availability: "available", endpoint: "unix:///tmp/sedes-test.sock",
        executableDirectory: "/host/bin", inheritedPath: "/usr/bin", closed, release }) } } });
    await service.prepareLaunch(source);
    expect(service.instructions(source)).toContain("'/host/bin/sedes'");
    expire(); await closed;
    let failure: unknown;
    try { service.instructions(source); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false, retryable: true });
    expect(String(failure)).not.toContain("antigravity_agent_tool");
    expect(release).toHaveBeenCalledOnce();
    await service.close();
  });
  it("fails closed for enabled tools without an endpoint and keeps disabled policy authoritative", async () => {
    const readPolicy = vi.fn(() => policy("native"));
    const issue = vi.fn(() => "capability");
    const service = new AntigravityAgentToolService({ facade: { readPolicy }, sourceCapabilities: { issue }, remote: true,
      cli: { availability: "unavailable", reason: "remote_environment" } });
    await expect(service.prepareLaunch(source)).rejects.toMatchObject({ crossedSubmissionBoundary: false, retryable: true });
    readPolicy.mockReturnValue(policy("native", false));
    expect(await service.prepareLaunch(source)).toBeUndefined(); expect(issue).not.toHaveBeenCalled();
  });
});
