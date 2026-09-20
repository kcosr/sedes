import { describe, expect, it } from "vitest";
import {
  normalizedApplicationSnapshotSchema,
  normalizedInstallationAdvisorySchema,
} from "../../src/shared/protocol/application.js";

const advisory = {
  id: "backend_instance/codex-local/runtime-newer-than-tested",
  tone: "warning" as const,
  title: { text: "Codex is newer than tested" },
  message: {
    text: "Running 0.154.0; Sedes is tested through 0.153.0.",
  },
  source: {
    kind: "backend_instance" as const,
    backendInstanceId: "codex-local",
    label: { text: "Local Codex" },
    environment: {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      label: { text: "Local" },
    },
    backend: "codex" as const,
  },
};

function emptySnapshot(advisories: readonly unknown[]) {
  return {
    environments: [],
    workspaces: [],
    threads: [],
    groups: [],
    forkOrigins: [],
    lineagePlacements: [],
    lineageFamilies: [],
    executionTargets: [],
    advisories,
    defaultNewThreadTargetId: null,
    counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}

describe("installation advisory normalized protocol", () => {
  it("accepts only bounded provider-neutral display data", () => {
    expect(normalizedInstallationAdvisorySchema.parse(advisory)).toEqual(
      advisory,
    );
    const { environment: _remoteEnvironment, ...localSource } = advisory.source;
    expect(
      normalizedInstallationAdvisorySchema.parse({
        ...advisory,
        source: localSource,
      }).source,
    ).toEqual(localSource);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        observedVersion: "0.154.0",
      }).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        source: {
          ...advisory.source,
          providerRuntime: { release: "0.154.0" },
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        source: {
          ...advisory.source,
          environment: {
            id: "local",
            label: { text: "x".repeat(4_097) },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        title: { text: "x".repeat(4_097) },
      }).success,
    ).toBe(false);
  });

  it("requires stable unique advisory IDs in an application snapshot", () => {
    expect(
      normalizedApplicationSnapshotSchema.safeParse(emptySnapshot([advisory]))
        .success,
    ).toBe(true);
    expect(
      normalizedApplicationSnapshotSchema.safeParse(
        emptySnapshot([advisory, advisory]),
      ).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        id: "backend_instance/codex-local/Runtime newer than tested",
      }).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        id: "application/storage-nearly-full",
      }).success,
    ).toBe(false);
    expect(
      normalizedInstallationAdvisorySchema.safeParse({
        ...advisory,
        id: "application/storage-nearly-full",
        source: { kind: "application" },
      }).success,
    ).toBe(true);
  });
});
