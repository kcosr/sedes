import {
  cannedPromptIdSchema,
  cannedPromptLibrarySchema,
  cannedPromptMutationResultSchema,
  createCannedPromptRequestSchema,
  deleteCannedPromptRequestSchema,
  reorderCannedPromptsRequestSchema,
  updateCannedPromptRequestSchema,
  type CannedPromptLibrary,
  type CannedPromptMutationResult,
  type CreateCannedPromptRequest,
  type DeleteCannedPromptRequest,
  type ReorderCannedPromptsRequest,
  type UpdateCannedPromptRequest,
} from "../../shared/protocol/canned-prompts.js";
import type { CannedPromptRepository } from "../db/repositories/canned-prompt-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** Validates and presents the principal-owned canned-prompt library. */
export class CannedPromptService {
  constructor(readonly repository: CannedPromptRepository) {}

  list(scope: RequestScope): CannedPromptLibrary {
    return cannedPromptLibrarySchema.parse(this.repository.list(scope));
  }

  create(
    scope: RequestScope,
    input: CreateCannedPromptRequest,
    now = Date.now(),
  ): CannedPromptMutationResult {
    const parsed = createCannedPromptRequestSchema.parse(input);
    return cannedPromptMutationResultSchema.parse(
      this.repository.create(scope, { ...parsed, now }),
    );
  }

  update(
    scope: RequestScope,
    promptId: string,
    input: UpdateCannedPromptRequest,
    now = Date.now(),
  ): CannedPromptMutationResult {
    const id = cannedPromptIdSchema.parse(promptId);
    const parsed = updateCannedPromptRequestSchema.parse(input);
    return cannedPromptMutationResultSchema.parse(
      this.repository.update(scope, id, { ...parsed, now }),
    );
  }

  delete(
    scope: RequestScope,
    promptId: string,
    input: DeleteCannedPromptRequest,
    now = Date.now(),
  ): CannedPromptMutationResult {
    const id = cannedPromptIdSchema.parse(promptId);
    const parsed = deleteCannedPromptRequestSchema.parse(input);
    return cannedPromptMutationResultSchema.parse(
      this.repository.delete(scope, id, { ...parsed, now }),
    );
  }

  reorder(
    scope: RequestScope,
    input: ReorderCannedPromptsRequest,
    now = Date.now(),
  ): CannedPromptMutationResult {
    const parsed = reorderCannedPromptsRequestSchema.parse(input);
    return cannedPromptMutationResultSchema.parse(
      this.repository.reorder(scope, { ...parsed, now }),
    );
  }
}
