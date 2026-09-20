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

  it.each(["codex_app_server", "claude_agent_sdk", "grok_build"] as const)(
    "preserves the explicit %s CLI presentation",
    (backendKind) => {
      expect(eligibility.presentationOptions(backendKind, "local")).toEqual([
        { surface: "cli", modes: ["progressive", "individual"] },
      ]);
      expect(eligibility.presentationOptions(backendKind, "outbound")).toEqual([
        { surface: "cli", modes: ["progressive", "individual"] },
      ]);
      expect(eligibility.presentationOptions(backendKind, "ssh")).toEqual([
        { surface: "cli", modes: ["progressive", "individual"] },
      ]);
    },
  );
});
