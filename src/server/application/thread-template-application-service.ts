import {
  threadTemplateDeleteResultSchema,
  threadTemplateListPageSchema,
  threadTemplateSchema,
  type CreateThreadTemplateRequest,
  type ThreadTemplate,
  type ThreadTemplateDeleteResult,
  type ThreadTemplateListPage,
  type UpdateThreadTemplateRequest,
} from "../../shared/protocol/thread-templates.js";
import type { ThreadTemplateRepository } from "../db/repositories/thread-template-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  PreparedThreadTemplateSelection,
  SavedAgentApplicationService,
} from "./saved-agent-application-service.js";

export class ThreadTemplateApplicationService {
  constructor(
    readonly input: {
      readonly repository: ThreadTemplateRepository;
      readonly savedAgents: Pick<
        SavedAgentApplicationService,
        "prepareThreadTemplateSelection"
      >;
      readonly now?: () => number;
    },
  ) {}

  list(
    scope: RequestScope,
    input: { readonly cursor?: string; readonly pageSize?: number } = {},
  ): ThreadTemplateListPage {
    const page = this.input.repository.listPage(scope, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      pageSize: input.pageSize ?? 50,
    });
    return threadTemplateListPageSchema.parse({
      items: page.items.map((record) => this.#present(record)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  get(scope: RequestScope, templateId: string): ThreadTemplate {
    return this.#present(this.input.repository.get(scope, templateId));
  }

  async create(
    scope: RequestScope,
    request: CreateThreadTemplateRequest,
    signal?: AbortSignal,
  ): Promise<ThreadTemplate> {
    const prepared =
      await this.input.savedAgents.prepareThreadTemplateSelection(
        scope,
        request,
        signal,
      );
    const selection = { ...this.#selection(prepared), environmentVariables: request.environmentVariables };
    return this.#present(
      this.input.repository.create(scope, {
        name: request.name,
        selection,
        assertReferences: prepared.assertDurableFences,
        now: this.input.now?.() ?? Date.now(),
      }),
    );
  }

  async update(
    scope: RequestScope,
    templateId: string,
    request: UpdateThreadTemplateRequest,
    signal?: AbortSignal,
  ): Promise<ThreadTemplate> {
    const current = this.input.repository.get(scope, templateId);
    const prepared =
      await this.input.savedAgents.prepareThreadTemplateSelection(
        scope,
        {
          workspaceId: request.workspaceId ?? current.workspaceId,
          targetId: request.targetId ?? current.targetId,
          executionWorkspace:
            request.executionWorkspace ?? current.executionWorkspace,
          agentId: request.agentId ?? current.agentId,
        },
        signal,
      );
    return this.#present(
      this.input.repository.update(scope, templateId, {
        expectedRevision: request.expectedRevision,
        name: request.name ?? current.name,
        selection: { ...this.#selection(prepared), environmentVariables: request.environmentVariables ?? current.environmentVariables },
        assertReferences: prepared.assertDurableFences,
        now: this.input.now?.() ?? Date.now(),
      }),
    );
  }

  delete(
    scope: RequestScope,
    templateId: string,
    expectedRevision: number,
  ): ThreadTemplateDeleteResult {
    this.input.repository.delete(scope, templateId, { expectedRevision });
    return threadTemplateDeleteResultSchema.parse({
      deleted: true,
      templateId,
    });
  }

  #selection(prepared: PreparedThreadTemplateSelection) {
    return {
      workspaceId: prepared.workspaceId,
      targetId: prepared.targetId,
      executionWorkspace: prepared.executionWorkspace,
      agentId: prepared.agentId,
      capturedAgentName: prepared.capturedAgentName,
      capturedWorkspaceName: prepared.capturedWorkspaceName,
      capturedTargetName: prepared.capturedTargetName,
    };
  }

  #present(
    record: ReturnType<ThreadTemplateRepository["get"]>,
  ): ThreadTemplate {
    return threadTemplateSchema.parse({
      id: record.id,
      name: record.name,
      workspaceId: record.workspaceId,
      targetId: record.targetId,
      executionWorkspace: record.executionWorkspace,
      agentId: record.agentId,
      ...(Object.keys(record.environmentVariables ?? {}).length ? { environmentVariables: record.environmentVariables } : {}),
      capturedAgentName: record.capturedAgentName,
      capturedWorkspaceName: record.capturedWorkspaceName,
      capturedTargetName: record.capturedTargetName,
      revision: record.revision,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    });
  }
}
