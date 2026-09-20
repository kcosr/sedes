import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  claudeSkillComposerCommands,
  claudeSkillId,
  findClaudeSafeSkill,
  resolveClaudeSafeSkills,
} from "../../src/server/backends/claude/claude-skills.js";
import { isClaudeSkillName } from "../../src/server/backends/claude/claude-skill-name.js";

const commands: SlashCommand[] = [
  {
    name: "review",
    description: "Review the current change",
    argumentHint: "[path]",
    aliases: ["code-review"],
  },
  {
    name: "doctor",
    description: "Inspect local setup",
    argumentHint: "",
  },
  {
    name: "compact",
    description: "Compact context",
    argumentHint: "[instructions]",
  },
];

describe("Claude safe skills", () => {
  it("requires positive skill classification and lets terminal exclusion win", () => {
    const skills = resolveClaudeSafeSkills({
      commands,
      skillNames: ["review", "doctor"],
      terminalCommandNames: ["doctor"],
    });

    expect(skills).toEqual([
      {
        id: claudeSkillId("review"),
        name: "review",
        reference: "/review",
        commandName: "review",
        description: "Review the current change",
      },
    ]);
    expect(claudeSkillComposerCommands(skills, commands)).toEqual([
      {
        invocation: "/review",
        source: "prompt",
        description: "Review the current change",
        argumentHint: "[path]",
      },
    ]);
  });

  it("does not treat aliases or unclassified built-ins as selectable skills", () => {
    const skills = resolveClaudeSafeSkills({
      commands,
      skillNames: ["code-review"],
      terminalCommandNames: [],
    });

    expect(skills).toEqual([]);
    expect(() => findClaudeSafeSkill(skills, claudeSkillId("review"))).toThrow(
      "claude_skill_unavailable",
    );
  });

  it("keeps stable identities for the workspace-scoped primary name", () => {
    expect(claudeSkillId("review")).toBe(claudeSkillId("review"));
    expect(claudeSkillId("review")).not.toBe(claudeSkillId("code-review"));
    expect(
      findClaudeSafeSkill(
        resolveClaudeSafeSkills({
          commands,
          skillNames: ["review"],
          terminalCommandNames: [],
        }),
        claudeSkillId("review"),
      ).commandName,
    ).toBe("review");
  });

  it("filters names outside the carrier grammar and caps the composer catalog", () => {
    for (const invalid of [
      "1review",
      "review:alias",
      "review skill",
      "réview",
      "a".repeat(161),
    ]) {
      expect(isClaudeSkillName(invalid)).toBe(false);
    }
    expect(isClaudeSkillName(`a${"b".repeat(159)}`)).toBe(true);

    const boundedCommands = Array.from({ length: 513 }, (_, index) => ({
      name: `skill-${index}`,
      description: "Safe",
      argumentHint: "",
    }));
    const providerCommands = [
      { name: "unsafe:name", description: "Unsafe", argumentHint: "" },
      ...boundedCommands,
    ];
    const skills = resolveClaudeSafeSkills({
      commands: providerCommands,
      skillNames: providerCommands.map(({ name }) => name),
      terminalCommandNames: [],
    });
    expect(skills).toHaveLength(511);
    expect(skills.some(({ name }) => name === "unsafe:name")).toBe(false);
    expect(skills.some(({ name }) => name === "skill-511")).toBe(false);
    expect(
      resolveClaudeSafeSkills({
        commands,
        skillNames: ["review"],
        terminalCommandNames: Array.from(
          { length: 513 },
          (_, index) => `terminal-${index}`,
        ),
      }),
    ).toEqual([]);
  });

  it("bounds provider-authored skill presentation metadata", () => {
    const oversized = "x".repeat(100_000);
    const providerCommands = [
      { name: "review", description: oversized, argumentHint: oversized },
    ];
    const skills = resolveClaudeSafeSkills({
      commands: providerCommands,
      skillNames: ["review"],
      terminalCommandNames: [],
    });
    expect(skills[0]?.description?.length).toBeLessThan(oversized.length);
    expect(
      claudeSkillComposerCommands(skills, providerCommands)[0]?.argumentHint
        ?.length,
    ).toBeLessThan(oversized.length);
  });
});
