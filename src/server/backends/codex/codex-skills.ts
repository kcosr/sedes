import { createHash } from "node:crypto";
import type { ApplicationPreferences } from "../../../shared/protocol/application-preferences.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { BackendSkillDescriptor } from "../contracts.js";
import { codexSkillsListMethod } from "./codex-c2-protocol.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";

const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const OPENAI_COMPOSER_SKILL_PREFIXES = [
  "openai-templates:",
  "sites:",
  "visualize:",
] as const;

export interface CodexComposerSkillPreferenceReader {
  read(scope: RequestScope): ApplicationPreferences;
}

export const defaultCodexComposerSkillPreferenceReader: CodexComposerSkillPreferenceReader =
  Object.freeze({
    read: () => ({ showOpenAIComposerSkills: false, revision: 0 }),
  });

export interface CodexNativeSkill extends BackendSkillDescriptor {
  readonly path: string;
}

export function codexSkillId(name: string, path: string): string {
  return `codex_skill_${createHash("sha256")
    .update(name)
    .update("\0")
    .update(path)
    .digest("base64url")
    .slice(0, 40)}`;
}

export async function readCodexSkills(
  client: CodexSharedClientFacade,
  canonicalWorkspacePath: string,
  forceReload: boolean,
  showOpenAIComposerSkills = false,
): Promise<{
  readonly generation: number;
  readonly skills: readonly CodexNativeSkill[];
  readonly errorCount: number;
}> {
  const response = await client.requestWithReceipt(
    codexSkillsListMethod,
    {
      cwds: [canonicalWorkspacePath],
      ...(forceReload ? { forceReload: true } : {}),
    },
    { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
  );
  if (
    response.result.data.length !== 1 ||
    response.result.data[0]?.cwd !== canonicalWorkspacePath
  ) {
    throw new Error("codex_skill_catalog_workspace_mismatch");
  }
  const entry = response.result.data[0];
  const ids = new Set<string>();
  const skills: CodexNativeSkill[] = [];
  for (const native of entry.skills) {
    // Bundled Codex skills remain enabled for the agent/runtime, but they are
    // not user-selectable composer entries in Sedes.
    if (
      !native.enabled ||
      native.scope === "system" ||
      (!showOpenAIComposerSkills &&
        OPENAI_COMPOSER_SKILL_PREFIXES.some((prefix) =>
          native.name.startsWith(prefix),
        ))
    ) {
      continue;
    }
    const id = codexSkillId(native.name, native.path);
    if (ids.has(id)) throw new Error("codex_skill_catalog_identity_collision");
    ids.add(id);
    skills.push({
      id,
      name: native.name,
      ...(native.interface?.displayName
        ? { displayName: native.interface.displayName }
        : {}),
      reference: `$${native.name}`,
      description: native.shortDescription ?? native.description,
      path: native.path,
    });
  }
  return {
    generation: response.generation,
    skills,
    errorCount: entry.errors.length,
  };
}

export async function resolveCodexSkill(
  client: CodexSharedClientFacade,
  canonicalWorkspacePath: string,
  selectedSkillId: string,
  showOpenAIComposerSkills = false,
): Promise<CodexNativeSkill> {
  const catalog = await readCodexSkills(
    client,
    canonicalWorkspacePath,
    true,
    showOpenAIComposerSkills,
  );
  const skill = catalog.skills.find(({ id }) => id === selectedSkillId);
  if (!skill) throw new Error("codex_skill_unavailable");
  return skill;
}
