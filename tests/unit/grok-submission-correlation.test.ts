import { describe, expect, it } from "vitest";
import {
  copyGrokSubmissionCorrelationKey,
  grokSubmissionPromptId,
  grokSubmissionPromptIdReadCandidates,
  inspectGrokSubmissionPromptId,
  matchesGrokSubmissionPromptId,
  type GrokSubmissionCorrelationScope,
} from "../../src/server/backends/grok/grok-submission-correlation.js";

const scope: GrokSubmissionCorrelationScope = Object.freeze({
  installationKey: new Uint8Array(32).fill(0x47),
  tenantId: "tenant-grok",
  principalId: "principal-grok",
  backendInstanceId: "grok-backend",
  connectionProfileId: "grok-connection",
  executionEnvironmentId: "10000000-0000-4000-8000-000000000081",
  nativeNamespaceKey: "grok-native:namespace",
  canonicalWorkspacePath: "/workspace/project",
  sessionId: "native-session",
});

const operation = Object.freeze({
  applicationOperationId: "application-operation",
  reconciliationToken: "durable-reconciliation-token",
});

describe("Grok submission correlation", () => {
  it("creates one canonical authenticated prompt identity", () => {
    const first = grokSubmissionPromptId({ ...scope, ...operation });
    const second = grokSubmissionPromptId({ ...scope, ...operation });

    expect(first).toBe(second);
    expect(first).toBe(
      "sedes-grok:v1:YXBwbGljYXRpb24tb3BlcmF0aW9u:pmCpOFcfIoDLAjcWul29OAH1Gxp3fGk9x-IaELbLGNQ:xGw95HzW8tmBiUmT3iA8aRLEwLao0bmwC-Ziq5k9tS0",
    );
    expect(first).toMatch(
      /^sedes-grok:v1:[^:]+:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/u,
    );
    expect(inspectGrokSubmissionPromptId(first, scope)).toEqual({
      type: "authenticated",
      applicationOperationId: operation.applicationOperationId,
    });
    expect(
      matchesGrokSubmissionPromptId(first, { ...scope, ...operation }),
    ).toBe(true);
    expect(
      matchesGrokSubmissionPromptId(first, {
        ...scope,
        ...operation,
        reconciliationToken: "different-token",
      }),
    ).toBe(false);
  });

  it("accepts the exact pre-rename prompt identity only on read", () => {
    const [current, legacy] = grokSubmissionPromptIdReadCandidates({
      ...scope,
      ...operation,
    });

    expect(current).toBe(grokSubmissionPromptId({ ...scope, ...operation }));
    expect(current).toMatch(/^sedes-grok:v1:/u);
    expect(legacy).toMatch(/^harness-grok:v1:/u);
    expect(inspectGrokSubmissionPromptId(legacy, scope)).toEqual({
      type: "authenticated",
      applicationOperationId: operation.applicationOperationId,
    });
    expect(
      matchesGrokSubmissionPromptId(legacy, { ...scope, ...operation }),
    ).toBe(true);
    expect(
      matchesGrokSubmissionPromptId(legacy, {
        ...scope,
        ...operation,
        reconciliationToken: "different-token",
      }),
    ).toBe(false);

    const forged = `${legacy.slice(0, -1)}${legacy.endsWith("A") ? "B" : "A"}`;
    expect(inspectGrokSubmissionPromptId(forged, scope)).toEqual({
      type: "forged",
    });
    expect(
      inspectGrokSubmissionPromptId("harness-grok:v2:value", scope),
    ).toEqual({ type: "malformed" });
  });

  it.each([
    ["tenantId", "other-tenant"],
    ["principalId", "other-principal"],
    ["backendInstanceId", "other-backend"],
    ["connectionProfileId", "other-connection"],
    ["executionEnvironmentId", "other-environment"],
    ["nativeNamespaceKey", "other-namespace"],
    ["canonicalWorkspacePath", "/workspace/other"],
    ["sessionId", "other-session"],
  ] as const)("rejects the prompt in a different %s scope", (field, value) => {
    const promptId = grokSubmissionPromptId({ ...scope, ...operation });
    expect(
      inspectGrokSubmissionPromptId(promptId, { ...scope, [field]: value }),
    ).toEqual({ type: "forged" });
  });

  it("distinguishes provider IDs from malformed and forged Sedes IDs", () => {
    expect(inspectGrokSubmissionPromptId("provider-prompt", scope)).toEqual({
      type: "non_sedes",
    });
    expect(inspectGrokSubmissionPromptId("sedes-grok:v2:value", scope)).toEqual(
      { type: "malformed" },
    );
    expect(
      inspectGrokSubmissionPromptId(
        "sedes-grok:v1:not-canonical:short:short",
        scope,
      ),
    ).toEqual({ type: "malformed" });

    const promptId = grokSubmissionPromptId({ ...scope, ...operation });
    const fields = promptId.split(":");
    fields[3] = `${fields[3]!.slice(0, -1)}${fields[3]!.endsWith("A") ? "B" : "A"}`;
    expect(inspectGrokSubmissionPromptId(fields.join(":"), scope)).toEqual({
      type: "forged",
    });
    expect(inspectGrokSubmissionPromptId(promptId)).toEqual({
      type: "forged",
    });
  });

  it("requires an owned 32-byte key and bounded operation identities", () => {
    const source = new Uint8Array(32).fill(7);
    const copied = copyGrokSubmissionCorrelationKey(source);
    source[0] = 9;
    expect(copied[0]).toBe(7);
    expect(() => copyGrokSubmissionCorrelationKey(new Uint8Array(31))).toThrow(
      "grok_submission_correlation_key_invalid",
    );
    expect(() =>
      grokSubmissionPromptId({
        ...scope,
        applicationOperationId: "",
        reconciliationToken: "token",
      }),
    ).toThrow("grok_submission_operation_id_invalid");
    expect(() =>
      grokSubmissionPromptId({
        ...scope,
        applicationOperationId: "operation",
        reconciliationToken: "",
      }),
    ).toThrow("grok_submission_reconciliation_token_invalid");
  });
});
