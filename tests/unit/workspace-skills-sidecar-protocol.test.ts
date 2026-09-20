import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SidecarOperationRegistry,
  WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES,
  registerWorkspaceSkillsV1Operations,
  workspaceSkillsCatalogReadOperation,
  workspaceSkillsResolveOperation,
  workspaceSkillsV1Operations,
} from "../../src/internal/sidecar-protocol/index.js";

describe("workspace skills sidecar protocol", () => {
  it("registers the closed catalog and resolution inventory", () => {
    const registry = new SidecarOperationRegistry();
    registerWorkspaceSkillsV1Operations(registry, {
      readCatalog: vi.fn() as never,
      resolveSkill: vi.fn() as never,
    });

    expect(workspaceSkillsV1Operations).toEqual([
      workspaceSkillsCatalogReadOperation,
      workspaceSkillsResolveOperation,
    ]);
    expect(registry.capabilities()).toEqual([
      {
        capabilityId: "workspace_skills",
        majorVersion: 1,
        operations: ["catalog.read", "skill.resolve"],
      },
    ]);
  });

  it("requires canonical authority and bounded, internally consistent content", () => {
    const request = {
      admissionId: randomUUID(),
      declaredPath: "/srv/projects/example",
      policyRootPath: "/srv/projects",
    };
    expect(
      workspaceSkillsCatalogReadOperation.requestSchema.safeParse(request)
        .success,
    ).toBe(true);
    expect(
      workspaceSkillsCatalogReadOperation.requestSchema.safeParse({
        ...request,
        declaredPath: "/srv/projects/../secret",
      }).success,
    ).toBe(false);

    const content = "---\nname: review\ndescription: Review code\n---\nBody";
    const digest = createHash("sha256").update(content).digest("hex");
    const skill = {
      id: "a".repeat(64),
      name: "review",
      description: "Review code",
      source: "workspace_pi" as const,
      filePath: "/srv/projects/example/.pi/skills/review/SKILL.md",
      baseDir: "/srv/projects/example/.pi/skills/review",
      contentSha256: digest,
      sizeBytes: Buffer.byteLength(content),
      disableModelInvocation: false,
    };
    expect(
      workspaceSkillsResolveOperation.responseSchema.safeParse({
        skill,
        content,
      }).success,
    ).toBe(true);
    expect(
      workspaceSkillsResolveOperation.responseSchema.safeParse({
        skill: {
          ...skill,
          contentSha256: "00".repeat(32),
          sizeBytes: WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES + 1,
        },
        content,
      }).success,
    ).toBe(false);
  });
});
