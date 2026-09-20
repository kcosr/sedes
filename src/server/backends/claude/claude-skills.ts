import { createHash } from "node:crypto";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendComposerCommand,
  BackendSkillDescriptor,
} from "../contracts.js";
import { isClaudeSkillName } from "./claude-skill-name.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

const MAXIMUM_CLAUDE_COMPOSER_SKILLS = 512;

export interface ClaudeSafeSkill extends BackendSkillDescriptor {
  readonly commandName: string;
}

export function claudeSkillId(commandName: string): string {
  return `claude_skill_${createHash("sha256")
    .update(commandName)
    .digest("base64url")
    .slice(0, 40)}`;
}

/**
 * Claude's control catalog mixes model-invoked skills with local, terminal,
 * settings, and session-lifecycle commands. Only the matching stream init can
 * classify which primary names are skills and which require a terminal.
 */
export function resolveClaudeSafeSkills(input: {
  readonly commands: readonly SlashCommand[];
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
}): readonly ClaudeSafeSkill[] {
  // Truncating a terminal exclusion list could turn an omitted terminal name
  // into a false-safe skill. Fail closed instead; positive catalogs may be
  // bounded because omission only makes a skill unavailable.
  if (input.terminalCommandNames.length > MAXIMUM_CLAUDE_COMPOSER_SKILLS) {
    return Object.freeze([]);
  }
  const skillNames = new Set(
    input.skillNames.slice(0, MAXIMUM_CLAUDE_COMPOSER_SKILLS),
  );
  const terminalNames = new Set(input.terminalCommandNames);
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const skills: ClaudeSafeSkill[] = [];
  for (const command of input.commands.slice(
    0,
    MAXIMUM_CLAUDE_COMPOSER_SKILLS,
  )) {
    if (
      !skillNames.has(command.name) ||
      terminalNames.has(command.name) ||
      !isClaudeSkillName(command.name) ||
      seenNames.has(command.name)
    ) {
      continue;
    }
    seenNames.add(command.name);
    const id = claudeSkillId(command.name);
    if (seenIds.has(id)) throw new Error("claude_skill_identity_collision");
    seenIds.add(id);
    skills.push({
      id,
      name: command.name,
      reference: `/${command.name}`,
      commandName: command.name,
      ...(command.description
        ? { description: boundDisplayText(command.description).text }
        : {}),
    });
  }
  return Object.freeze(skills);
}

export function claudeSkillComposerCommands(
  skills: readonly ClaudeSafeSkill[],
  commands: readonly SlashCommand[],
): readonly BackendComposerCommand[] {
  const commandByName = new Map(
    commands.map((command) => [command.name, command]),
  );
  return skills.map((skill) => {
    const command = commandByName.get(skill.commandName);
    return {
      invocation: skill.reference,
      source: "prompt" as const,
      ...(skill.description ? { description: skill.description } : {}),
      ...(command?.argumentHint
        ? { argumentHint: boundDisplayText(command.argumentHint).text }
        : {}),
    };
  });
}

export function findClaudeSafeSkill(
  skills: readonly ClaudeSafeSkill[],
  selectedSkillId: string,
): ClaudeSafeSkill {
  const skill = skills.find(({ id }) => id === selectedSkillId);
  if (!skill) throw new Error("claude_skill_unavailable");
  return skill;
}
