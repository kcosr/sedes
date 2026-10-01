import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ModelInfo } from "@opencode/client";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import type { AgentConnectionProfile, BackendCatalog, BackendModelDescriptor } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { assertOpenCodeCatalogPolicy, qualifiedOpenCodeModelId } from "./opencode-model-selection.js";

export interface OpenCodeModelCatalogRead {
  readonly catalog: BackendCatalog;
  readonly modelsById: ReadonlyMap<string, ModelInfo>;
  readonly revision: string;
}
export class OpenCodeModelCatalog {
  constructor(readonly input: {
    readonly readNative: (directory: string, signal?: AbortSignal) => Promise<{ readonly models: readonly ModelInfo[]; readonly defaultModel?: ModelInfo }>;
    readonly modelPolicy: CompiledBackendModelPolicy;
  }) { assertOpenCodeCatalogPolicy(input.modelPolicy); }
  async read(input: { readonly connection: AgentConnectionProfile; readonly workspace: ValidatedWorkspace; readonly signal?: AbortSignal }): Promise<OpenCodeModelCatalogRead> {
    if (input.connection.kind !== "opencode_http" || !input.connection.enabled || !input.workspace.canonicalPath.startsWith("/")) throw new Error("opencode_catalog_target_invalid");
    const native = await this.input.readNative(input.workspace.canonicalPath, input.signal);
    const models: BackendModelDescriptor[] = [];
    const modelsById = new Map<string, ModelInfo>();
    const notices: BackendCatalog["notices"][number][] = [];
    let excluded = false;
    const seen = new Set<string>();
    for (const model of native.models) {
      const identity = JSON.stringify([model.providerID, model.id]);
      if (seen.has(identity)) throw new Error("opencode_catalog_duplicate_identity");
      seen.add(identity);
      if (!model.enabled) continue;
      if (!model.package || !model.capabilities.input.includes("text")) { excluded = true; continue; }
      let id: string;
      try { id = qualifiedOpenCodeModelId(model); } catch { excluded = true; continue; }
      if (models.length >= 511) { excluded = true; continue; }
      const reviewed = model.variants.filter(variant => reviewedOpenCodeEffort(model, variant));
      const efforts = reviewed.slice(0, 510).map(variant => variant.id);
      if (reviewed.length > 510) excluded = true;
      if (new Set(model.variants.map(variant => variant.id)).size !== model.variants.length) throw new Error("opencode_catalog_duplicate_variant");
      models.push({ provider: input.connection.id, id,
        label: `${model.name} (${model.providerID}/${model.id})${model.status === "deprecated" ? " — deprecated" : ""}`,
        inputModalities: model.capabilities.input.includes("image") ? ["text", "image"] : ["text"],
        ...(native.defaultModel?.providerID === model.providerID && native.defaultModel.id === model.id ? { isDefault: true as const } : {}),
        supportedReasoningEfforts: ["default", ...efforts], defaultReasoningEffort: "default" });
      modelsById.set(id, model);
    }
    if (excluded) notices.push(boundDisplayText("Some OpenCode models are unavailable because their package, text capability, identity, or catalog size is unsupported."));
    const revision = createHash("sha256").update(JSON.stringify({ directory: input.workspace.canonicalPath,
      connectionId: input.connection.id, native, policy: this.input.modelPolicy.policy })).digest("hex");
    return { catalog: { models, commands: [], skills: [], notices }, modelsById, revision };
  }
}

/** Exact pinned native OpenAI overlays only. Labels and arbitrary plugin variants prove nothing. */
export function reviewedOpenCodeEffort(model: ModelInfo, variant: ModelInfo["variants"][number]): boolean {
  if (!variant.id || variant.id === "default" || variant.id.length > 120 || /\p{Cc}/u.test(variant.id) || Buffer.from(variant.id, "utf8").toString("utf8") !== variant.id) return false;
  if (Object.keys(variant.headers ?? {}).length || Object.keys(variant.body ?? {}).length) return false;
  if (model.package === "@opencode/ai/providers/openai-compatible") {
    return isDeepStrictEqual(variant.settings, { reasoningEffort: variant.id }) &&
      (!Object.hasOwn(model.body ?? {}, "reasoning_effort") || model.body!.reasoning_effort === variant.id);
  }
  if (model.package === "@opencode/ai/providers/openai") {
    if (!isDeepStrictEqual(variant.settings, { reasoningEffort: variant.id, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] })) return false;
    const body = model.body ?? {};
    // Raw body is merged last by the native provider; it must not replace the reviewed settings.
    return (!Object.hasOwn(body, "reasoning") || isDeepStrictEqual(body.reasoning, { effort: variant.id, summary: "auto" })) &&
      (!Object.hasOwn(body, "include") || isDeepStrictEqual(body.include, ["reasoning.encrypted_content"]));
  }
  return false;
}
