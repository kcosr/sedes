import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

interface AcpSdkFeasibility {
  package: {
    name: string;
    version: string;
    license: string;
    registryIntegrity: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    stableSchemaDialect?: string;
    packageJsonSha256: string;
    licenseSha256: string;
    stableSchemaSha256: string;
  };
  licenseAudit: {
    sdkDisposition: string;
    noticeFilePresent: boolean;
    runtimeDependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
    peerDependency: {
      name: string;
      resolvedVersion: string;
      license: string;
      licenseSha256: string;
    };
  };
  publicSurface: {
    exportsLowLevelConnection: boolean;
    exportsWireStream: boolean;
    exportsStableSchemaFile: boolean;
    sourceHasUnboundedPendingMap: boolean;
    sourceHasUnboundedIncomingMap: boolean;
    requestDeadlineOptionAuthority: string;
    exposesRequestDeadlineOption: boolean;
  };
  behavior: {
    deliveryClassification: {
      dispositionPreserved: boolean;
    };
    resultValidation: {
      builtInInvalidResultAccepted: boolean;
    };
    outgoingConcurrency: {
      attempted: number;
      acceptedWithoutEngineCapacityError: number;
    };
    incomingConcurrencyAndExtension: {
      attempted: number;
      maximumActive: number;
      extensionRegistrationWorks: boolean;
    };
    perSessionRouting: {
      crossSessionIsolation: boolean;
      queuedWithoutCapacityFailure: number;
    };
    cancellation: {
      protocolCancelMethod: string;
      requestRemainsPendingAfterAbort: boolean;
    };
    reverseAuthority: {
      handlerRanWithoutInitialize: boolean;
      engineEnforcesNegotiatedCapability: boolean;
    };
    diagnostics: {
      rawWireMarkerExposed: boolean;
    };
    stableBatchRejection: {
      stableConnectionClosedOnBatch: boolean;
    };
    idsAndDuplicates: {
      fractionalRequestIdAccepted: boolean;
      duplicateResponseLoggedAsUnknown: boolean;
      duplicateResponseTombstoneExposed: boolean;
    };
  };
  decision: {
    correlationOwner: string;
    sharedCorrelatedCore: string;
    adapterShape: string;
    schemaCompiler: string;
    syntheticNonGrokProfile: string;
    reverseAuthorityRule: string;
    deadlineRule: string;
    idRule: string;
    dependencyPin: string;
    dependencyClass: string;
    subsystems: Record<string, string>;
  };
}

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFileAsync = promisify(execFile);

async function readEvidence(): Promise<AcpSdkFeasibility> {
  const value: unknown = JSON.parse(
    await readFile(
      path.join(rootDirectory, "protocol/acp-sdk/1.3.0/feasibility.json"),
      "utf8",
    ),
  );
  return value as AcpSdkFeasibility;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("ACP SDK D1b feasibility decision", () => {
  it("regenerates the complete canonical evidence from offline probe facts", async () => {
    const fixturePath = path.join(
      rootDirectory,
      "tests/fixtures/acp-sdk-1.3.0-probe-facts.json",
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        path.join(
          rootDirectory,
          "scripts/provider-protocol/probe-acp-sdk-1.3.0.mjs",
        ),
        "--fixture",
        fixturePath,
      ],
      { cwd: rootDirectory },
    );
    const expected = await readEvidence();

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(expected);
    expect(stdout).not.toContain("secret-marker-never-recorded");
    expect(await readFile(fixturePath, "utf8")).not.toContain(
      "secret-marker-never-recorded",
    );
  });

  it("pins the audited stable package and license", async () => {
    const [evidence, packageManifest, packageLock] = await Promise.all([
      readEvidence(),
      readFile(path.join(rootDirectory, "package.json"), "utf8").then(
        JSON.parse,
      ),
      readFile(path.join(rootDirectory, "package-lock.json"), "utf8").then(
        JSON.parse,
      ),
    ]);

    expect(evidence.package).toMatchObject({
      name: "@agentclientprotocol/sdk",
      version: "1.3.0",
      license: "Apache-2.0",
      registryIntegrity:
        "sha512-i3h/efaeuMUFAO1HSfo97QZQnnvMd7wWBYtBsdL6UMZg3a78sk3Ffya5Xu7C7tYsXomXoDXJBAzQF2PcFKAhIQ==",
    });
    expect(evidence.decision).toMatchObject({
      dependencyPin: "@agentclientprotocol/sdk@1.3.0",
      dependencyClass: "runtime-exact",
      schemaCompiler:
        "Ajv2020 strict non-mutating named validators plus Sedes refinements",
    });
    expect(evidence.package.dependencies).toEqual({});
    expect(evidence.package.optionalDependencies).toEqual({});
    expect(evidence.package.peerDependencies).toEqual({
      zod: "^3.25.0 || ^4.0.0",
    });
    expect(evidence.package.stableSchemaDialect).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(evidence.licenseAudit).toMatchObject({
      sdkDisposition:
        "compatible-permissive; retain Apache-2.0 license in distributions",
      noticeFilePresent: false,
      runtimeDependencies: {},
      optionalDependencies: {},
      peerDependency: {
        name: "zod",
        resolvedVersion: "4.4.3",
        license: "MIT",
      },
    });
    expect(packageManifest.dependencies["@agentclientprotocol/sdk"]).toBe(
      "1.3.0",
    );
    expect(
      packageLock.packages["node_modules/@agentclientprotocol/sdk"],
    ).toMatchObject({
      version: "1.3.0",
      integrity: evidence.package.registryIntegrity,
      license: "Apache-2.0",
    });

    const sdkRoot = path.join(
      rootDirectory,
      "node_modules/@agentclientprotocol/sdk",
    );
    const zodRoot = path.join(rootDirectory, "node_modules/zod");
    await expect(
      Promise.all([
        sha256File(path.join(sdkRoot, "package.json")),
        sha256File(path.join(sdkRoot, "LICENSE")),
        sha256File(path.join(sdkRoot, "schema/schema.json")),
        sha256File(path.join(zodRoot, "LICENSE")),
      ]),
    ).resolves.toEqual([
      evidence.package.packageJsonSha256,
      evidence.package.licenseSha256,
      evidence.package.stableSchemaSha256,
      evidence.licenseAudit.peerDependency.licenseSha256,
    ]);
  });

  it("rejects SDK-owned correlation from executable evidence", async () => {
    const evidence = await readEvidence();

    expect(evidence.publicSurface).toMatchObject({
      exportsLowLevelConnection: false,
      exportsWireStream: false,
      exportsStableSchemaFile: true,
      sourceHasUnboundedPendingMap: true,
      sourceHasUnboundedIncomingMap: true,
      requestDeadlineOptionAuthority: "public SendRequestOptions declaration",
      exposesRequestDeadlineOption: false,
    });
    expect(evidence.behavior.outgoingConcurrency).toEqual({
      attempted: 64,
      acceptedWithoutEngineCapacityError: 64,
    });
    expect(evidence.behavior.incomingConcurrencyAndExtension).toMatchObject({
      attempted: 64,
      maximumActive: 64,
      extensionRegistrationWorks: true,
    });
    expect(
      evidence.behavior.resultValidation.builtInInvalidResultAccepted,
    ).toBe(true);
    expect(evidence.behavior.diagnostics.rawWireMarkerExposed).toBe(true);
    expect(evidence.decision.correlationOwner).toBe("sedes");
    expect(evidence.decision.sharedCorrelatedCore).toBe("rejected");
    expect(evidence.decision.adapterShape).toContain("sedes-peer");
    expect(evidence.decision.subsystems.connectionEngine).toBe("rejected");
  });

  it("records cancellation, routing, delivery, and reverse-authority limits", async () => {
    const evidence = await readEvidence();

    expect(evidence.behavior.deliveryClassification.dispositionPreserved).toBe(
      true,
    );
    expect(evidence.behavior.cancellation).toMatchObject({
      protocolCancelMethod: "$/cancel_request",
      requestRemainsPendingAfterAbort: true,
    });
    expect(evidence.behavior.perSessionRouting).toEqual({
      crossSessionIsolation: true,
      queuedWithoutCapacityFailure: 64,
    });
    expect(evidence.behavior.reverseAuthority).toMatchObject({
      handlerRanWithoutInitialize: true,
      engineEnforcesNegotiatedCapability: false,
    });
    expect(
      evidence.behavior.stableBatchRejection.stableConnectionClosedOnBatch,
    ).toBe(true);
    expect(evidence.behavior.idsAndDuplicates).toEqual({
      fractionalRequestIdAccepted: true,
      duplicateResponseLoggedAsUnknown: true,
      duplicateResponseTombstoneExposed: false,
    });
    expect(evidence.decision.syntheticNonGrokProfile).toBe(
      "probe/* extension profile",
    );
    expect(evidence.decision.reverseAuthorityRule).toContain(
      "before authority resolution",
    );
    expect(evidence.decision.deadlineRule).toContain("generation");
    expect(evidence.decision.idRule).toContain("reject duplicates");
  });

  it("keeps every SDK subsystem disposition closed", async () => {
    const evidence = await readEvidence();
    const allowed = new Set([
      "adopted",
      "wrapped",
      "types/schema only",
      "rejected",
    ]);

    expect(Object.keys(evidence.decision.subsystems).length).toBeGreaterThan(0);
    for (const disposition of Object.values(evidence.decision.subsystems)) {
      expect(allowed.has(disposition)).toBe(true);
    }
  });
});
