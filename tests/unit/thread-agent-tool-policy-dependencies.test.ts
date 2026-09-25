import { describe, expect, it } from "vitest";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";

describe("thread agent tool backend eligibility", () => {
  const eligibility = createThreadAgentToolPolicyDependencies().eligibility;

  it("preserves the explicit Pi local and SSH presentations", () => {
    expect(eligibility.presentationOptions("pi", "local")).toEqual([
      { surface: "native", modes: ["progressive", "individual"] },
      { surface: "cli", modes: ["progressive", "individual"] },
    ]);
    expect(eligibility.presentationOptions("pi", "outbound")).toEqual([
      { surface: "native", modes: ["progressive", "individual"] },
    ]);
    expect(eligibility.presentationOptions("pi", "ssh")).toEqual([
      { surface: "native", modes: ["progressive", "individual"] },
    ]);
  });

  it.each(["codex_app_server", "claude_agent_sdk"] as const)(
    "defaults %s to MCP-backed Native Individual, with both CLI modes",
    (backendKind) => {
      for (const environmentKind of ["local", "outbound", "ssh"] as const) {
        expect(
          eligibility.presentationOptions(backendKind, environmentKind),
        ).toEqual([
          { surface: "native", modes: ["individual", "progressive"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ]);
      }
    },
  );

  it("preserves the explicit Grok CLI-only presentation", () => {
    for (const environmentKind of ["local", "outbound", "ssh"] as const) {
      expect(
        eligibility.presentationOptions("grok_build", environmentKind),
      ).toEqual([{ surface: "cli", modes: ["progressive", "individual"] }]);
    }
  });
});
