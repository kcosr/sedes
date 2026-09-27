import { savedAgentBackendTypeIdSchema } from "../../../shared/protocol/saved-agents.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { SavedAgentBackendAdapter } from "../saved-agent-adapter.js";

/** Required contribution; no configuration is advertised before execution is admitted. */
export class OpenCodeSavedAgentBackendAdapter implements SavedAgentBackendAdapter {
  readonly typeId = savedAgentBackendTypeIdSchema.parse("opencode");
  readonly backendKind = "opencode" as const;
  readonly presentation = Object.freeze({ typeId: this.typeId, label: boundDisplayText("OpenCode"), brand: "opencode" as const });
  readonly overrideSchemaVersion = 1;
  validateOverrides(..._input: Parameters<SavedAgentBackendAdapter["validateOverrides"]>): never { throw unavailable(); }
  prepareResolutionContext(..._input: Parameters<SavedAgentBackendAdapter["prepareResolutionContext"]>): never { throw unavailable(); }
  describeEditor(..._input: Parameters<SavedAgentBackendAdapter["describeEditor"]>): never { throw unavailable(); }
  resolve(..._input: Parameters<SavedAgentBackendAdapter["resolve"]>): never { throw unavailable(); }
  captureThreadConfiguration(..._input: Parameters<SavedAgentBackendAdapter["captureThreadConfiguration"]>): never { throw unavailable(); }
  assertThreadConfigurationCapture(..._input: Parameters<SavedAgentBackendAdapter["assertThreadConfigurationCapture"]>): never { throw unavailable(); }
  initializeNewThread(..._input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>): never { throw unavailable(); }
}
function unavailable(): DomainError {
  return new DomainError("invalid_transition", "OpenCode Saved Agent configuration is unavailable.");
}
