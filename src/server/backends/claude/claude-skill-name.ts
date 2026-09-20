const SKILL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,159}$/u;

/** Shared persisted/catalog grammar for Claude primary skill names. */
export function isClaudeSkillName(value: string): boolean {
  return SKILL_NAME_PATTERN.test(value);
}
