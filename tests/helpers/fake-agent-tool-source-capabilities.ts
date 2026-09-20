import { vi } from "vitest";
import type { AgentToolSourceCapabilityIssuer } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";

export function createFakeAgentToolSourceCapabilities(): Readonly<{
  issuer: AgentToolSourceCapabilityIssuer;
  issue: ReturnType<typeof vi.fn<AgentToolSourceCapabilityIssuer["issue"]>>;
}> {
  const issue = vi.fn<AgentToolSourceCapabilityIssuer["issue"]>(
    () => "htr2_" + "a".repeat(64),
  );
  return {
    issuer: { issue },
    issue,
  };
}
