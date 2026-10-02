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
        aliases: ["code-review"],
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

  it("classifies renamed skills through directory aliases and keeps canonical selection", () => {
    const skills = resolveClaudeSafeSkills({
      commands,
      skillNames: ["code-review"],
      terminalCommandNames: [],
    });

    expect(skills).toEqual([expect.objectContaining({
      id: claudeSkillId("review"), name: "review", commandName: "review",
      reference: "/review", aliases: ["code-review"],
    })]);
    expect(claudeSkillComposerCommands(skills, commands).map(({ invocation }) => invocation)).toEqual(["/review"]);
    expect(() => findClaudeSafeSkill(skills, claudeSkillId("code-review"))).toThrow(
      "claude_skill_unavailable",
    );
  });

  it("retains only aliases whose native resolution uniquely reaches the canonical skill", () => {
    const providerCommands: SlashCommand[] = [
      { name: "review", description: "Review", argumentHint: "", aliases: ["directory", "primary", "terminal", "shared", "review", "directory", "unsafe:name"] },
      { name: "primary", description: "Not a skill", argumentHint: "", builtin: true },
      { name: "other", description: "Other", argumentHint: "", aliases: ["shared"] },
    ];
    for (const ordered of [providerCommands, [...providerCommands].reverse()]) {
      const skills = resolveClaudeSafeSkills({ commands: ordered, skillNames: ["review"], terminalCommandNames: ["terminal"] });
      expect(skills).toEqual([expect.objectContaining({ name: "review", aliases: ["directory"] })]);
      expect(resolveClaudeSafeSkills({ commands: ordered, skillNames: ["terminal", "shared"], terminalCommandNames: ["terminal"] })).toEqual([]);
    }
  });

  it.each([
    { name: "clear", aliases: ["reset", "new"] },
    { name: "usage", aliases: ["cost", "stats"] },
  ])("does not classify builtin /$name through a model-only skill's name", ({ name, aliases }) => {
    const builtin = { name, aliases, builtin: true, description: "Native local command", argumentHint: "" };
    expect(resolveClaudeSafeSkills({ commands: [builtin], skillNames: aliases, terminalCommandNames: [] })).toEqual([]);
    // Builtin aliases still prevent an ambiguous custom alias from classifying a skill.
    const custom = { name: "custom-review", aliases: [aliases[0]!], description: "Custom skill", argumentHint: "" };
    for (const ordered of [[builtin, custom], [custom, builtin]]) {
      expect(resolveClaudeSafeSkills({ commands: ordered, skillNames: [aliases[0]!], terminalCommandNames: [] })).toEqual([]);
    }
  });

  it("uses the builtin primary winner and its metadata before classifying aliases", () => {
    const providerCommands: SlashCommand[] = [
      { name: "review", description: "Shadowed user skill", argumentHint: "wrong", aliases: ["old-review"] },
      { name: "review", description: "Native review skill", argumentHint: "[path]", builtin: true },
    ];
    for (const ordered of [providerCommands, [...providerCommands].reverse()]) {
      expect(resolveClaudeSafeSkills({ commands: ordered, skillNames: ["old-review"], terminalCommandNames: [] })).toEqual([]);
      const skills = resolveClaudeSafeSkills({ commands: ordered, skillNames: ["review", "old-review"], terminalCommandNames: [] });
      expect(skills).toEqual([expect.objectContaining({ name: "review", description: "Native review skill" })]);
      expect(skills[0]?.aliases).toBeUndefined();
      expect(claudeSkillComposerCommands(skills, ordered)).toEqual([{
        invocation: "/review", source: "prompt", description: "Native review skill", argumentHint: "[path]",
      }]);
      expect(resolveClaudeSafeSkills({ commands: ordered, skillNames: ["review"], terminalCommandNames: ["review"] })).toEqual([]);
    }
    expect(resolveClaudeSafeSkills({ commands: providerCommands.map(({ builtin: _builtin, ...command }) => command), skillNames: ["review"], terminalCommandNames: [] })).toEqual([]);
  });

  it("checks exclusions beyond the output limit and rejects oversized exclusion metadata", () => {
    const providerCommands = [
      { name: "review", description: "Review", argumentHint: "", aliases: ["later"] },
      ...Array.from({ length: 512 }, (_, index) => ({ name: `other-${index}`, description: "", argumentHint: "" })),
      { name: "later", description: "Primary shadows alias", argumentHint: "" },
    ];
    expect(resolveClaudeSafeSkills({ commands: providerCommands, skillNames: ["review"], terminalCommandNames: [] })[0]?.aliases).toBeUndefined();
    expect(resolveClaudeSafeSkills({ commands: [{ ...commands[0]!, aliases: Array.from({ length: 129 }, (_, index) => `alias-${index}`) }], skillNames: ["review"], terminalCommandNames: [] })).toEqual([]);
    expect(resolveClaudeSafeSkills({ commands: Array.from({ length: 4097 }, () => commands[0]!), skillNames: ["review"], terminalCommandNames: [] })).toEqual([]);
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
