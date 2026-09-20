import {
  workspaceFilesMutationListOperation,
  workspaceFilesMutationInspectOperation,
  workspaceFilesMutationAcknowledgeOperation,
  workspaceToolsMutationListOperation,
  workspaceToolsMutationInspectOperation,
  workspaceToolsMutationAcknowledgeOperation,
  workspaceToolsShellListOperation,
  workspaceToolsShellInspectOperation,
  workspaceToolsShellAcknowledgeOperation,
} from "../../internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "./sidecar-client-session.js";
import {
  configurationOperationRecoveryDetailsSchema,
  type ConfigurationOperationRecoveryKind,
  type ConfigurationOperationRecoveryReference,
  type ConfigurationOperationRecoverySummary,
  type ConfigurationOperationRecoveryDetails,
} from "../../shared/protocol/configuration-operation-recovery.js";

/** Server-side administration seam. Acquire the session with authenticated
 * principal/environment authority and check its granted capability first.
 * Inspect never acknowledges; disposition must be a separate explicit action. */
export class SidecarOperationRecoveryClient {
  constructor(readonly session: SidecarClientSession) {}

  listFileMutations() {
    return this.session.call(workspaceFilesMutationListOperation, {});
  }
  inspectFileMutation(operationId: string) {
    return this.session.call(workspaceFilesMutationInspectOperation, {
      operationId,
    });
  }
  acknowledgeFileMutation(operationId: string) {
    return this.session.call(workspaceFilesMutationAcknowledgeOperation, {
      operationId,
    });
  }
  listWorkspaceMutations() {
    return this.session.call(workspaceToolsMutationListOperation, {});
  }
  inspectWorkspaceMutation(operationId: string) {
    return this.session.call(workspaceToolsMutationInspectOperation, {
      operationId,
    });
  }
  acknowledgeWorkspaceMutation(operationId: string) {
    return this.session.call(workspaceToolsMutationAcknowledgeOperation, {
      operationId,
    });
  }
  listShells() {
    return this.session.call(workspaceToolsShellListOperation, {});
  }
  inspectShell(streamId: string) {
    return this.session.call(workspaceToolsShellInspectOperation, { streamId });
  }
  acknowledgeShell(streamId: string) {
    return this.session.call(workspaceToolsShellAcknowledgeOperation, {
      streamId,
    });
  }

  async list(
    kinds: readonly ConfigurationOperationRecoveryKind[],
  ): Promise<{ receipts: ConfigurationOperationRecoverySummary[] }> {
    const receipts: ConfigurationOperationRecoverySummary[] = [];
    for (const kind of new Set(kinds)) {
      const ids =
        kind === "shell"
          ? (await this.listShells()).streamIds
          : kind === "file"
            ? (await this.listFileMutations()).operationIds
            : (await this.listWorkspaceMutations()).operationIds;
      // Bound reverse requests; a list is observational, never a disposition.
      for (let offset = 0; offset < ids.length; offset += 8) {
        const details = await Promise.all(
          ids
            .slice(offset, offset + 8)
            .map((receiptId) => this.inspect({ kind, receiptId })),
        );
        receipts.push(
          ...details.map(
            ({
              details: _details,
              stdout: _stdout,
              stderr: _stderr,
              omittedBytes: _omittedBytes,
              ...summary
            }) => summary,
          ),
        );
      }
    }
    return { receipts };
  }

  async inspect(
    reference: ConfigurationOperationRecoveryReference,
  ): Promise<ConfigurationOperationRecoveryDetails> {
    const { kind, receiptId } = reference;
    if (kind === "shell") {
      const result = await this.inspectShell(receiptId);
      const terminal = result.terminal;
      const state =
        result.state === "running"
          ? "pending"
          : result.state === "unknown"
            ? "unknown"
            : terminal?.outcome === "exited" && terminal.exitCode === 0
              ? "succeeded"
              : "failed";
      const stdout = boundedText(
        Buffer.from(result.stdoutBase64, "base64").toString("utf8"),
      );
      const stderr = boundedText(
        Buffer.from(result.stderrBase64, "base64").toString("utf8"),
      );
      return configurationOperationRecoveryDetailsSchema.parse({
        ...reference,
        state,
        summary: terminal
          ? `Command ${terminal.outcome}${terminal.exitCode === null ? "" : ` (exit ${terminal.exitCode})`}.`
          : state === "pending"
            ? "Command is still running."
            : "Command outcome is unknown.",
        acknowledgeable: terminal !== null,
        details: terminal ? JSON.stringify(terminal, null, 2) : "",
        stdout: stdout.text,
        stderr: stderr.text,
        omittedBytes:
          result.previewOmittedBytes +
          stdout.omittedBytes +
          stderr.omittedBytes,
      });
    }
    const result =
      kind === "file"
        ? await this.inspectFileMutation(receiptId)
        : await this.inspectWorkspaceMutation(receiptId);
    const details = boundedText(
      result.state === "succeeded"
        ? JSON.stringify(result.result, null, 2)
        : result.state === "failed"
          ? result.code
          : "",
    );
    return configurationOperationRecoveryDetailsSchema.parse({
      ...reference,
      state: result.state,
      summary:
        result.state === "succeeded"
          ? "Operation completed."
          : result.state === "failed"
            ? `Operation failed (${result.code}).`
            : result.state === "pending"
              ? "Operation is still running."
              : result.state === "unknown" && result.settled
                ? "Operation ended without a definitive outcome. Inspect the workspace before acknowledging."
                : "Operation outcome is unknown.",
      acknowledgeable:
        result.state === "succeeded" ||
        result.state === "failed" ||
        (result.state === "unknown" && result.settled),
      details: details.text,
      stdout: "",
      stderr: "",
      omittedBytes: details.omittedBytes,
    });
  }

  acknowledge({ kind, receiptId }: ConfigurationOperationRecoveryReference) {
    return kind === "shell"
      ? this.acknowledgeShell(receiptId)
      : kind === "file"
        ? this.acknowledgeFileMutation(receiptId)
        : this.acknowledgeWorkspaceMutation(receiptId);
  }
}

function boundedText(value: string): { text: string; omittedBytes: number } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= 65_536) return { text: value, omittedBytes: 0 };
  // Drop an incomplete trailing code point rather than introducing replacement bytes.
  let end = 65_536;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return {
    text: encoded.subarray(0, end).toString("utf8"),
    omittedBytes: encoded.byteLength - end,
  };
}
