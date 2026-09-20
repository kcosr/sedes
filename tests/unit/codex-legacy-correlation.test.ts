import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  codexClientUserMessageId,
  codexForkContextBoundaryHookRunId,
  codexForkCreationMarker,
  codexSubmissionReconciliationClientUserMessageIds,
  inspectCodexForkContextBoundaryHookRunId,
  inspectCodexForkCreationMarker,
  inspectCodexSubmissionCorrelation,
  type CodexSubmissionCorrelationScope,
} from "../../src/server/backends/codex/codex-submission-correlation.js";

const toolProvenanceKey = new Uint8Array(32).fill(0x48);

const scope: CodexSubmissionCorrelationScope = {
  toolProvenanceKey,
  tenantId: "tenant-one",
  principalId: "principal-one",
  backendInstanceId: "codex-one",
  nativeThreadId: "native-thread-one",
  correlationAncestorThreadIds: [],
};

/**
 * Re-derives the exact pre-rename (Harness) marker formats so fixtures are
 * byte-identical to what pre-cutover code persisted into Codex native history.
 */
function legacyHmacTag(domain: string, fields: readonly string[]): string {
  const hmac = createHmac("sha256", toolProvenanceKey);
  const append = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hmac.update(length);
    hmac.update(bytes);
  };
  append(domain);
  for (const field of fields) append(field);
  return hmac.digest("base64url");
}

function scopeFields(
  operationId: string,
  nativeThreadId: string = scope.nativeThreadId,
): readonly string[] {
  return [
    scope.tenantId,
    scope.principalId,
    scope.backendInstanceId,
    nativeThreadId,
    operationId,
  ];
}

function legacyClientUserMessageId(
  operationId: string,
  claimedOperationId: string = operationId,
): string {
  const encoded = Buffer.from(claimedOperationId, "utf8").toString("base64url");
  const reconciliationTag = legacyHmacTag(
    "harness.codex-submission.reconciliation.v1",
    [...scopeFields(operationId), "legacy-reconciliation-token"],
  );
  const provenanceTag = legacyHmacTag(
    "harness.codex-submission.provenance.v1",
    [...scopeFields(operationId), reconciliationTag],
  );
  return `harness:v3:${encoded}:${provenanceTag}:${reconciliationTag}`;
}

function legacyForkCreationMarker(
  operationId: string,
  nativeThreadId: string = scope.nativeThreadId,
): string {
  const encoded = Buffer.from(operationId, "utf8").toString("base64url");
  const tag = legacyHmacTag(
    "harness.codex-fork.provenance.v1",
    scopeFields(operationId, nativeThreadId),
  );
  return `harness-fork:v1:${encoded}:${tag}`;
}

function legacyForkBoundaryHookRunId(
  operationId: string,
  nativeThreadId: string = scope.nativeThreadId,
): string {
  const encoded = Buffer.from(operationId, "utf8").toString("base64url");
  const tag = legacyHmacTag(
    "harness.codex-fork-boundary.provenance.v1",
    scopeFields(operationId, nativeThreadId),
  );
  return `harness-fork-boundary:v1:${encoded}:${tag}`;
}

describe("legacy pre-rename Codex correlation markers", () => {
  it("authenticates pre-cutover client user message IDs under the legacy domain", () => {
    const inspection = inspectCodexSubmissionCorrelation(
      legacyClientUserMessageId("legacy-operation-one"),
      scope,
    );
    expect(inspection).toEqual({
      type: "authenticated",
      applicationOperationId: "legacy-operation-one",
    });
  });

  it("classifies tampered legacy client user message IDs as forged", () => {
    const inspection = inspectCodexSubmissionCorrelation(
      legacyClientUserMessageId("legacy-operation-two"),
      scope,
    );
    expect(inspection.type).toBe("authenticated");
    const forged = legacyClientUserMessageId("legacy-operation-one");
    const inspected = inspectCodexSubmissionCorrelation(forged, {
      ...scope,
      principalId: "principal-two",
    });
    expect(inspected).toEqual({ type: "forged" });
    expect(
      inspectCodexSubmissionCorrelation(
        legacyClientUserMessageId(
          "legacy-operation-one",
          "substituted-operation",
        ),
        scope,
      ),
    ).toEqual({ type: "forged" });
  });

  it("derives the exact legacy client ID only as a reconciliation read candidate", () => {
    const [current, legacy] = codexSubmissionReconciliationClientUserMessageIds(
      {
        ...scope,
        applicationOperationId: "legacy-operation-one",
        reconciliationToken: "legacy-reconciliation-token",
      },
    );
    expect(current).toMatch(/^sedes:v3:/u);
    expect(legacy).toBe(legacyClientUserMessageId("legacy-operation-one"));
  });

  it("classifies legacy-family IDs missing the version prefix as malformed", () => {
    expect(
      inspectCodexSubmissionCorrelation("harness:plain-provider-id", scope),
    ).toEqual({ type: "malformed" });
  });

  it("classifies foreign provider IDs as non-sedes", () => {
    expect(
      inspectCodexSubmissionCorrelation("codex-native-message-123", scope),
    ).toEqual({ type: "non_sedes" });
  });

  it("classifies legacy fork markers as non-sedes in the client ID inspector", () => {
    expect(
      inspectCodexSubmissionCorrelation(
        legacyForkCreationMarker("fork-op"),
        scope,
      ),
    ).toEqual({ type: "non_sedes" });
  });

  it("authenticates pre-cutover fork creation markers in the exact scope", () => {
    expect(
      inspectCodexForkCreationMarker(
        legacyForkCreationMarker("legacy-fork-operation"),
        scope,
      ),
    ).toEqual({
      type: "authenticated",
      applicationOperationId: "legacy-fork-operation",
    });
  });

  it("classifies legacy fork creation markers from another native scope as forged", () => {
    expect(
      inspectCodexForkCreationMarker(
        legacyForkCreationMarker(
          "legacy-fork-operation",
          "other-native-thread",
        ),
        scope,
      ),
    ).toEqual({ type: "forged" });
  });

  it("authenticates pre-cutover fork boundary hook run IDs in the exact native scope", () => {
    expect(
      inspectCodexForkContextBoundaryHookRunId(
        legacyForkBoundaryHookRunId("legacy-boundary-operation"),
        scope,
      ),
    ).toEqual({
      type: "authenticated",
      applicationOperationId: "legacy-boundary-operation",
    });
    expect(
      inspectCodexForkContextBoundaryHookRunId(
        legacyForkBoundaryHookRunId(
          "legacy-boundary-operation",
          "other-native-thread",
        ),
        scope,
      ),
    ).toEqual({ type: "forged" });
  });

  it("still authenticates current Sedes markers after the legacy allowance", () => {
    const clientId = codexClientUserMessageId({
      ...scope,
      applicationOperationId: "current-operation",
      reconciliationToken: "test-reconciliation-token",
    });
    expect(inspectCodexSubmissionCorrelation(clientId, scope)).toEqual({
      type: "authenticated",
      applicationOperationId: "current-operation",
    });
    expect(
      inspectCodexForkCreationMarker(
        codexForkCreationMarker({
          ...scope,
          applicationOperationId: "current-fork-operation",
        }),
        scope,
      ),
    ).toEqual({
      type: "authenticated",
      applicationOperationId: "current-fork-operation",
    });
    expect(
      inspectCodexForkContextBoundaryHookRunId(
        codexForkContextBoundaryHookRunId({
          ...scope,
          applicationOperationId: "current-boundary-operation",
        }),
        scope,
      ),
    ).toEqual({
      type: "authenticated",
      applicationOperationId: "current-boundary-operation",
    });
  });
});
