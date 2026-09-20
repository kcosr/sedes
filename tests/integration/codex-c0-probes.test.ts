import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const evidenceRoot = path.join(
  repositoryRoot,
  "protocol",
  "codex-app-server",
  "0.153.0",
  "evidence",
);

function runProbe(filename: string): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "codex-probes", filename)],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    ),
  );
}

function evidence(filename: string): unknown {
  return JSON.parse(readFileSync(path.join(evidenceRoot, filename), "utf8"));
}

describe.sequential("Codex 0.153.0 C0 release probes", () => {
  it("starts the pinned stable app-server without enabling experimental APIs", () => {
    expect(runProbe("probe-release.mjs")).toMatchObject({
      release: "0.153.0",
      initialized: true,
      stableThreadList: true,
      experimentalMethodRejected: true,
    });
  }, 30_000);

  it("proves bind-before-turn creation across confirmed and uncertain crashes", () => {
    const actual = runProbe("probe-d1-empty-thread.mjs");
    expect(actual).toEqual(evidence("d1-empty-thread.json"));
    expect(actual).toMatchObject({
      creationIdempotencyKey: false,
      acceptedStartResponseCapturedBeforeCrash: true,
      acceptedStartResponseWithheldFromCaller: true,
      acceptedStartCallerOutcomeAfterCrash: "response_unknown",
      acceptedStartDurableAfterRestart: false,
      fixtureBindingRecordWrittenBeforeFirstTurn: true,
      materializedThreadDurableAfterRestart: true,
      gateDisposition:
        "requires explicit user approval of empty-orphan risk or import-only creation before C3",
    });
  }, 30_000);

  it("selects no Sedes tools while the full D2a matrix is unproven", () => {
    const actual = runProbe("probe-d2a-mcp-isolation.mjs");
    expect(actual).toEqual(evidence("d2a-mcp-isolation.json"));
    expect(actual).toMatchObject({
      topologyDecision:
        "principal-scoped shared conversation daemon with no Sedes tools",
      concurrentThreadsObserved: 2,
      sharedDaemonMcpChildStoppedAfterUnsubscribe: false,
      sharedDaemonSameMcpSessionCallableAfterUnsubscribe: true,
      promptSharedDaemonRunRotationAvailable: false,
      sameHomeConcurrentMutationSafetyProven: false,
      activeRunAuthorizationProven: false,
      retainedClientRevocationProven: false,
      isolatedProcessThreadConfinementProven: false,
      workspaceCommandDirectEnvironmentExcludedCredential: false,
      sameUidProcessCredentialNonObservabilityProven: false,
      staleCredentialRejectionAfterResumeForkReloadRestartProven: false,
      rawSecretsFoundInPostRunTempScan: false,
    });
  }, 30_000);
});
