import { createHash } from "node:crypto";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendComposerCommand,
  BackendSkillDescriptor,
} from "../contracts.js";
import { isClaudeSkillName } from "./claude-skill-name.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

const MAXIMUM_CLAUDE_COMPOSER_SKILLS = 512;
const MAXIMUM_CLAUDE_COMMANDS = 4_096;
const MAXIMUM_CLAUDE_SKILL_ALIASES = 128;

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
 * classify skills and commands requiring a terminal. Renamed skills retain
 * their directory name in stream init and expose it as a control-catalog alias.
 */
export function resolveClaudeSafeSkills(input: {
  readonly commands: readonly SlashCommand[];
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
}): readonly ClaudeSafeSkill[] {
  // Truncating a terminal exclusion list could turn an omitted terminal name
  // into a false-safe skill. Fail closed instead; positive catalogs may be
  // bounded because omission only makes a skill unavailable.
  if (
    input.terminalCommandNames.length > MAXIMUM_CLAUDE_COMPOSER_SKILLS ||
    input.commands.length > MAXIMUM_CLAUDE_COMMANDS ||
    input.commands.some(
      (command) => (command.aliases?.length ?? 0) > MAXIMUM_CLAUDE_SKILL_ALIASES,
    )
  ) {
    return Object.freeze([]);
  }
  const skillNames = new Set(
    input.skillNames.slice(0, MAXIMUM_CLAUDE_COMPOSER_SKILLS),
  );
  const terminalNames = new Set(input.terminalCommandNames);
  // Resolve against the whole bounded catalog before limiting positive rows:
  // an omitted primary, built-in, or terminal command must still shadow aliases.
  const commandByName = primaryCommands(input.commands);
  const aliasOwners = new Map<string, Set<SlashCommand>>();
  for (const command of input.commands) {
    for (const alias of command.aliases ?? []) {
      if (
        !isClaudeSkillName(alias) ||
        commandByName.has(alias) ||
        terminalNames.has(alias)
      ) continue;
      const owners = aliasOwners.get(alias) ?? new Set<SlashCommand>();
      owners.add(command);
      aliasOwners.set(alias, owners);
    }
  }
  const seenIds = new Set<string>();
  const skills: ClaudeSafeSkill[] = [];
  for (const command of commandByName.values()) {
    if (
      !command ||
      terminalNames.has(command.name) ||
      !isClaudeSkillName(command.name)
    ) {
      continue;
    }
    const aliases = [...new Set(command.aliases ?? [])].filter(
      (alias) => aliasOwners.get(alias)?.size === 1,
    );
    if (
      !skillNames.has(command.name) &&
      (command.builtin === true || !aliases.some((alias) => skillNames.has(alias)))
    ) continue;
    const id = claudeSkillId(command.name);
    if (seenIds.has(id)) throw new Error("claude_skill_identity_collision");
    seenIds.add(id);
    skills.push({
      id,
      name: command.name,
      reference: `/${command.name}`,
      commandName: command.name,
      ...(aliases.length ? { aliases } : {}),
      ...(command.description
        ? { description: boundDisplayText(command.description).text }
        : {}),
    });
    if (skills.length === MAXIMUM_CLAUDE_COMPOSER_SKILLS) break;
  }
  return Object.freeze(skills);
}

export function claudeSkillComposerCommands(
  skills: readonly ClaudeSafeSkill[],
  commands: readonly SlashCommand[],
): readonly BackendComposerCommand[] {
  const commandByName = primaryCommands(commands);
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

/** Claude prefers built-in primary names; ambiguous equal-precedence rows fail closed. */
function primaryCommands(
  commands: readonly SlashCommand[],
): Map<string, SlashCommand | undefined> {
  const rows = new Map<string, SlashCommand[]>();
  for (const command of commands.slice(0, MAXIMUM_CLAUDE_COMMANDS)) {
    const named = rows.get(command.name) ?? [];
    named.push(command);
    rows.set(command.name, named);
  }
  return new Map(
    [...rows].map(([name, named]) => {
      const builtins = named.filter((command) => command.builtin);
      const candidates = builtins.length ? builtins : named;
      return [name, candidates.length === 1 ? candidates[0] : undefined];
    }),
  );
}

export function findClaudeSafeSkill(
  skills: readonly ClaudeSafeSkill[],
  selectedSkillId: string,
): ClaudeSafeSkill {
  const skill = skills.find(({ id }) => id === selectedSkillId);
  if (!skill) throw new Error("claude_skill_unavailable");
  return skill;
}
