import { imageShowRequestSchema } from "../../../shared/protocol/image-show.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ImageShowService, ImageShowPublicationAuthority } from "../../output-artifacts/image-show-service.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";

export class ImageShowAgentToolService {
  constructor(readonly dependencies: {
    images: ImageShowService;
    capturePublication: (scope: RequestScope, threadId: string) => ReturnType<ImageShowPublicationAuthority["capture"]>;
  }) {}

  async execute(raw: unknown, context: TrustedToolInvocationContext) {
    if (context.subject.kind !== "thread_agent") {
      throw new DomainError("bad_request", "Showing an image requires a source thread.");
    }
    const input = imageShowRequestSchema.parse(raw);
    const scope = { tenantId: context.tenantId, principalId: context.principalId };
    const threadId = context.subject.sourceThreadId;
    return this.dependencies.images.show(scope, threadId, input, {
      invocationId: context.requestId,
      capture: () => this.dependencies.capturePublication(scope, threadId),
    }, context.abortSignal);
  }
}
