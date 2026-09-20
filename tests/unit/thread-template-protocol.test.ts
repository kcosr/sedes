import { describe, expect, it } from "vitest";
import {
  createThreadTemplateRequestSchema,
  threadTemplateSchema,
  updateThreadTemplateRequestSchema,
} from "../../src/shared/protocol/thread-templates.js";

const template = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Review in isolation",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  targetId: "local-pi",
  executionWorkspace: {
    kind: "isolated" as const,
    workspaceAccess: "writable_clone" as const,
    networkProfile: "isolated" as const,
  },
  agentId: "30000000-0000-4000-8000-000000000001",
  capturedAgentName: "Reviewer",
  capturedWorkspaceName: "Sedes",
  capturedTargetName: "Local Pi",
  revision: 0,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("thread template protocol", () => {
  it("models one complete Saved-Agent recipe without custom settings", () => {
    expect(threadTemplateSchema.parse(template)).toEqual(template);
    expect(
      createThreadTemplateRequestSchema.safeParse({
        name: template.name,
        workspaceId: template.workspaceId,
        targetId: template.targetId,
        executionWorkspace: template.executionWorkspace,
        agentId: template.agentId,
      }).success,
    ).toBe(true);
    expect(
      createThreadTemplateRequestSchema.safeParse({
        name: template.name,
        workspaceId: template.workspaceId,
        targetId: template.targetId,
        executionWorkspace: { kind: "direct" },
        configuration: { kind: "custom", backendOverrides: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps captured labels server-owned and requires a real update", () => {
    expect(
      createThreadTemplateRequestSchema.safeParse({
        name: template.name,
        workspaceId: template.workspaceId,
        targetId: template.targetId,
        executionWorkspace: { kind: "direct" },
        agentId: template.agentId,
        capturedAgentName: "Browser authority",
      }).success,
    ).toBe(false);
    expect(
      updateThreadTemplateRequestSchema.safeParse({ expectedRevision: 0 })
        .success,
    ).toBe(false);
    expect(
      updateThreadTemplateRequestSchema.safeParse({
        expectedRevision: 0,
        agentId: template.agentId,
      }).success,
    ).toBe(true);
  });
});
