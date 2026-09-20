import type { ThreadMutationGateway } from "../../conversations/thread-mutation-gateway.js";
import type { AgentThreadDirectSendResult } from "../../conversations/thread-mutation-gateway.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { InventoryRepository } from "../../db/repositories/inventory-repository.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../environment/environment-authority.js";
import type { ToolInitiator } from "../contracts/tool-initiator.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";

export type AgentThreadDirectSendInput = {
  readonly initiator: ToolInitiator;
  readonly targetThreadId: string;
  readonly message: string;
  readonly callback?: boolean;
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
};

/** Canonical-tool application facade; provider and HTTP details stay below it. */
export class AgentThreadControlService {
  constructor(
    readonly gateway: Pick<ThreadMutationGateway, "sendDirect">,
    readonly inventory: Pick<InventoryRepository, "getThread">,
  ) {}

  sendDirect(
    scope: RequestScope,
    input: AgentThreadDirectSendInput,
  ): Promise<AgentThreadDirectSendResult> {
    if (input.callback === true && input.initiator.kind !== "thread_agent") {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "Completion callbacks are available only to thread-agent callers.",
      );
    }
    const target = this.inventory.getThread(scope, input.targetThreadId);
    requireAdmittedResource(input.environmentAuthority, {
      kind: "thread",
      id: target.thread.id,
      environmentId: target.thread.environmentId,
      workspaceId: target.thread.workspaceId,
    });
    return this.gateway.sendDirect(scope, {
      initiator: input.initiator,
      targetThreadId: input.targetThreadId,
      message: input.message,
      callback: input.callback === true,
      mutationId: input.mutationId,
    });
  }
}

export type { AgentThreadDirectSendResult };
