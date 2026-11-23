import { z } from "zod";
import { threadApplicationOperationSchema } from "../../../shared/protocol/api.js";
import { mutationIdSchema, threadIdSchema } from "../../../shared/protocol/domain.js";
import { agentToolIdSchema, agentToolPresentationSchema, agentToolResourceScopeSchema, appliedToolPolicySetReferenceSchema } from "../../../shared/protocol/conversation.js";
import {
  createToolPolicySetRequestSchema, deleteToolPolicySetRequestSchema,
  resolveToolPolicyRequestSchema, toolPolicySelectionSchema,
  toolPolicySelectionTargetSchema, toolPolicySetIdSchema, toolPolicySetListQuerySchema,
  updateToolPolicySelectionRequestSchema, updateToolPolicySetRequestSchema,
} from "../../../shared/protocol/tool-policies.js";
import { threadTemplateIdSchema, threadTemplateListQuerySchema, updateThreadTemplateRequestSchema, type ThreadTemplate } from "../../../shared/protocol/thread-templates.js";
import type { ThreadTemplateApplicationService } from "../../application/thread-template-application-service.js";
import type { ThreadMutationGateway } from "../../conversations/thread-mutation-gateway.js";
import type { PrincipalAgentToolClientRepository } from "../../db/repositories/principal-agent-tool-client-repository.js";
import type { ThreadAgentToolPolicyRepository } from "../../db/repositories/thread-agent-tool-policy-repository.js";
import type { ToolPolicyService } from "../../tool-policies/tool-policy-service.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { assertToolPolicyWithinCaller } from "../application/assert-tool-policy-within-caller.js";
import { ExecutionManagementAccess } from "../application/execution-management-access.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { environmentAuthorityContinuationDigest, type AgentToolEnvironmentAuthorityReader } from "../environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import type { PolicyManagementToolId } from "./policy-management-tools.js";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policyIdInput = z.strictObject({ policySetId: toolPolicySetIdSchema });
const threadIdInput = z.strictObject({ threadId: threadIdSchema });
const templateIdInput = z.strictObject({ templateId: threadTemplateIdSchema });
const threadUpdateInput = z.strictObject({
  threadId: threadIdSchema, mutationId: mutationIdSchema, expectedPolicyRevision: revision,
  enabled: z.boolean(), enabledToolIds: z.array(agentToolIdSchema).max(512),
  resourceScope: agentToolResourceScopeSchema, presentation: agentToolPresentationSchema,
  policySet: appliedToolPolicySetReferenceSchema.nullable().optional(),
});
const templateUpdateInput = z.strictObject({
  templateId: threadTemplateIdSchema, expectedRevision: revision,
  toolPolicySelection: toolPolicySelectionSchema.optional(),
  toolPresentation: agentToolPresentationSchema.nullable().optional(),
});

/** Principal-scoped policy administration; assignment authority stays bounded by the source thread. */
export class PolicyManagementAgentToolService {
  readonly #access: ExecutionManagementAccess;

  constructor(private readonly input: {
    readonly policySets: Pick<ToolPolicyService, "options" | "list" | "get" | "create" | "update" | "delete" | "getSelection" | "updateSelection" | "preview">;
    readonly templates: Pick<ThreadTemplateApplicationService, "list" | "get" | "update">;
    readonly toolPolicies: Pick<ThreadAgentToolPolicyRepository, "getDurable" | "presentationOptions">;
    readonly principalToolClients: Pick<PrincipalAgentToolClientRepository, "get">;
    readonly authorityReader: AgentToolEnvironmentAuthorityReader;
    readonly mutations: Pick<ThreadMutationGateway, "mutate">;
  }) {
    this.#access = new ExecutionManagementAccess(input.authorityReader, input.toolPolicies);
  }

  async execute(toolId: PolicyManagementToolId, raw: unknown, context: TrustedToolInvocationContext): Promise<unknown> {
    const scope = this.#access.assertCaller(context, toolId);
    switch (toolId) {
      case "tool_policy.options": {
        const request = z.strictObject({}).parse(raw);
        this.#access.revalidate(context, toolId, request);
        const options = this.input.policySets.options(scope);
        return { groups: options.groups.map(group => ({
          id: group.id, label: group.label.text, description: group.description.text, order: group.order,
          tools: group.tools.map(tool => ({
            id: tool.id, label: tool.label.text, order: tool.order, effects: tool.effects,
            available: tool.available,
            ...(tool.description ? { description: tool.description.text } : {}),
            ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason.text } : {}),
          })),
        })) };
      }
      case "tool_policy.list": {
        const request = toolPolicySetListQuerySchema.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return this.input.policySets.list(scope, request);
      }
      case "tool_policy.get": {
        const request = policyIdInput.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return { policySet: this.input.policySets.get(scope, request.policySetId) };
      }
      case "tool_policy.create": {
        const request = createToolPolicySetRequestSchema.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return { policySet: this.input.policySets.create(scope, request) };
      }
      case "tool_policy.update": {
        const { policySetId, ...request } = z.strictObject({ policySetId: toolPolicySetIdSchema, ...updateToolPolicySetRequestSchema.shape }).parse(raw);
        const parsed = updateToolPolicySetRequestSchema.parse(request);
        this.#access.revalidate(context, toolId, { policySetId, ...parsed });
        return { policySet: this.input.policySets.update(scope, policySetId, parsed) };
      }
      case "tool_policy.remove": {
        const { policySetId, ...request } = z.strictObject({ policySetId: toolPolicySetIdSchema, ...deleteToolPolicySetRequestSchema.shape }).parse(raw);
        this.#access.revalidate(context, toolId, { policySetId, ...request });
        return this.input.policySets.delete(scope, policySetId, request.expectedRevision);
      }
      case "tool_policy.defaults.get": {
        const request = z.strictObject({ target: toolPolicySelectionTargetSchema }).parse(raw);
        this.#access.revalidate(context, toolId, request);
        return { setting: this.input.policySets.getSelection(scope, request.target) };
      }
      case "tool_policy.defaults.update": {
        const request = updateToolPolicySelectionRequestSchema.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return { setting: this.input.policySets.updateSelection(scope, request) };
      }
      case "tool_policy.preview": {
        const request = resolveToolPolicyRequestSchema.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return this.input.policySets.preview(scope, request);
      }
      case "thread.tool_settings.get": {
        const request = threadIdInput.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return this.#threadSettings(scope, request.threadId);
      }
      case "thread.tool_settings.update": {
        const request = threadUpdateInput.parse(raw);
        const { threadId, ...settings } = request;
        const operation = threadApplicationOperationSchema.parse({ kind: "set_agent_tool_policy", ...settings });
        const assertPolicyAuthority = () => {
          this.#access.assertCaller(context, toolId);
          this.#access.revalidate(context, toolId, request);
          this.#access.sourceThreadUpdate(context, threadId);
          this.#withinCaller(scope, context, settings);
        };
        assertPolicyAuthority();
        await this.input.mutations.mutate(scope, threadId, operation, { assertPolicyAuthority });
        // The gateway finishes this write before returning. mutationId only correlates
        // the response; reusing it with the old revision is not a durable replay.
        return { mutationId: request.mutationId, ...this.#threadSettings(scope, threadId) };
      }
      case "thread_template.list": {
        const request = threadTemplateListQuerySchema.parse(raw);
        const authority = this.#access.revalidate(context, toolId, request);
        const page = this.input.templates.list(scope, request, {
          environmentIds: authority.targetEnvironmentIds,
          ...(!context.environmentAuthority.resourceScope!.allowOtherProjects ? { projectId: context.defaults.projectId! } : {}),
          continuationKey: environmentAuthorityContinuationDigest(context.environmentAuthority, CANONICAL_AGENT_TOOL_MANIFEST[toolId]),
        });
        return { ...page, items: page.items.map(presentTemplate) };
      }
      case "thread_template.get": {
        const request = templateIdInput.parse(raw);
        this.#access.revalidate(context, toolId, request);
        return { template: presentTemplate(this.input.templates.get(scope, request.templateId)) };
      }
      case "thread_template.update": {
        const { templateId, ...patch } = templateUpdateInput.parse(raw);
        const request = updateThreadTemplateRequestSchema.parse(patch);
        const assertAuthority = () => {
          this.#access.assertCaller(context, toolId);
          this.#access.revalidate(context, toolId, { templateId, ...request });
          const current = this.input.templates.get(scope, templateId);
          const policy = this.input.policySets.preview(scope, {
            targetId: current.targetId, agentId: current.agentId,
            threadSelection: request.toolPolicySelection ?? current.toolPolicySelection,
          });
          this.#withinCaller(scope, context, policy);
        };
        assertAuthority();
        return { template: presentTemplate(await this.input.templates.update(scope, templateId, request, context.abortSignal, assertAuthority)) };
      }
    }
  }

  #withinCaller(scope: RequestScope, context: TrustedToolInvocationContext, requested: Parameters<typeof assertToolPolicyWithinCaller>[0]["requested"]): void {
    assertToolPolicyWithinCaller({ scope, authority: context.environmentAuthority, requested, toolPolicies: this.input.toolPolicies, principalToolClients: this.input.principalToolClients });
  }

  #threadSettings(scope: RequestScope, threadId: string) {
    const policy = this.input.toolPolicies.getDurable(scope, threadId);
    return {
      threadId, enabled: policy.enabled, enabledToolIds: [...policy.enabledToolIds],
      resourceScope: policy.resourceScope, presentation: policy.presentation,
      presentationOptions: [...this.input.toolPolicies.presentationOptions(scope, threadId)],
      revision: policy.revision, policySet: policy.policySet,
    };
  }
}

function presentTemplate(template: ThreadTemplate): Omit<ThreadTemplate, "environmentVariables"> {
  const { environmentVariables: _environmentVariables, ...visible } = template;
  return visible;
}
