import { createHash } from "node:crypto";
import type { AgentConnectionProfile, BackendCatalog, BackendSkillDescriptor } from "../contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { openCodeConversationError } from "./opencode-conversation-context.js";
import type { OpenCodeNativeSkill } from "./opencode-native-mutations.js";

interface SkillReadInput {
  readonly connection: AgentConnectionProfile;
  readonly workspace: ValidatedWorkspace;
  readonly signal?: AbortSignal;
}
export interface OpenCodeSkillCatalogRead {
  readonly skills: readonly BackendSkillDescriptor[];
  readonly selections: ReadonlyMap<string, string>;
  readonly notices: BackendCatalog["notices"];
}

/** Native skill bodies and source paths stay inside the bounded native reader. */
export class OpenCodeSkillCatalog {
  constructor(readonly input: {
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly nativeNamespaceKey: string;
    readonly readNative: (directory: string, signal?: AbortSignal) => Promise<readonly OpenCodeNativeSkill[]>;
  }) {}

  async read(input: SkillReadInput): Promise<OpenCodeSkillCatalogRead> {
    const connection = input.connection;
    if (connection.tenantId !== this.input.scope.tenantId || connection.ownerPrincipalId !== this.input.scope.principalId ||
        connection.backendInstanceId !== this.input.backendInstanceId || connection.kind !== "opencode_http" || !connection.enabled ||
        connection.executionEnvironmentId !== input.workspace.summary.environmentId || !input.workspace.canonicalPath.startsWith("/")) throw unavailable();
    input.signal?.throwIfAborted();
    const native = await this.input.readNative(input.workspace.canonicalPath, input.signal);
    input.signal?.throwIfAborted();
    if (native.length > 4_096 || new Set(native.map(skill => skill.id)).size !== native.length) throw unavailable();
    const skills: BackendSkillDescriptor[] = [], selections = new Map<string, string>();
    let excluded = false;
    for (const skill of native) {
      if (!clean(skill.id, 239) || !clean(skill.name, 160) || skills.length >= 512) { excluded = true; continue; }
      const id = `oc_skill_${createHash("sha256").update(JSON.stringify([this.input.scope, this.input.backendInstanceId,
        this.input.nativeNamespaceKey, connection.id, connection.executionEnvironmentId, input.workspace.canonicalPath, skill.id])).digest("hex")}`;
      skills.push(Object.freeze({ id, name: skill.name, reference: `@${skill.id}`,
        ...(skill.description ? { description: boundDisplayText(skill.description).text } : {}) }));
      selections.set(id, skill.id);
    }
    return { skills: Object.freeze(skills), selections,
      notices: excluded ? [boundDisplayText("Some OpenCode skills exceed the supported catalog limits.")] : [] };
  }

  async resolve(input: SkillReadInput & { readonly selectedSkillId: string }): Promise<string> {
    if (!/^oc_skill_[0-9a-f]{64}$/u.test(input.selectedSkillId)) throw unavailable();
    // Fresh resolution is required before admission; a dispatched replay never calls this.
    const catalog = await this.read(input);
    const id = catalog.selections.get(input.selectedSkillId);
    if (!id) throw unavailable();
    return id;
  }
}
function clean(value: string, maximum: number): boolean {
  return typeof value === "string" && !!value && value.length <= maximum && !/\p{Cc}/u.test(value) && Buffer.from(value).toString("utf8") === value;
}
function unavailable() { return openCodeConversationError("opencode_skill_unavailable", "The selected OpenCode skill is unavailable in this workspace.", "invalid_state"); }
