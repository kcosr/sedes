import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const profileRoot = path.join(repositoryRoot, "protocol/grok-acp/1.0.4");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(profileRoot, relative), "utf8"));
}

describe("Grok G0 profile scaffold", () => {
  it("keeps candidate verification non-executing and stages a private copy", () => {
    const source = readFileSync(
      path.join(repositoryRoot, "scripts/grok-probes/pinned-grok-release.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /node:child_process|\bspawn(?:Sync)?\b|\bexecFile/u,
    );
    expect(source).toContain("O_NOFOLLOW");
    expect(source).toContain("O_EXCL");
    expect(source).toContain("0o700");
    expect(source).toContain("0o500");
    expect(source).toContain("hashOpenFileBounded");
    expect(source).toContain("stageVerifiedGrokCandidate");
    expect(source).toContain("retainedFileDescriptor");
    expect(source).not.toContain("mountSourcePath");
    expect(source).toContain("retainedFile");
  });

  it("passes the deterministic sanitized artifact checker", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/grok-probes/check-grok-profile.mjs"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ).not.toThrow();
  });

  it("rejects a candidate replacement during O0 capture", () => {
    const moduleUrl = new URL(
      "../../scripts/grok-probes/pinned-grok-release.mjs",
      import.meta.url,
    ).href;
    const script = `
      const { assertSameVerifiedIdentity } = await import(${JSON.stringify(moduleUrl)});
      const initial = {
        verifier: "pinned_grok_1.0.4",
        executableSha256: "expected",
        immutableIdentity: "original"
      };
      const replaced = {
        ...initial,
        immutableIdentity: "replacement"
      };
      let rejected = false;
      try { assertSameVerifiedIdentity(initial, replaced); } catch { rejected = true; }
      if (!rejected) process.exit(9);
    `;
    expect(() =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      ),
    ).not.toThrow();
  });

  it("propagates a pre-aborted non-executing verification", () => {
    const moduleUrl = new URL(
      "../../scripts/grok-probes/pinned-grok-release.mjs",
      import.meta.url,
    ).href;
    const script = `
      const { verifyPinnedGrokCandidateNonExecuting } = await import(${JSON.stringify(moduleUrl)});
      const controller = new AbortController();
      const reason = new Error("deadline");
      controller.abort(reason);
      let observed;
      try {
        await verifyPinnedGrokCandidateNonExecuting({ signal: controller.signal });
      } catch (error) {
        observed = error;
      }
      if (observed !== reason) process.exit(10);
    `;
    expect(() =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      ),
    ).not.toThrow();
  });

  it("records exact candidate provenance and reviewed runtime admission", () => {
    const release = readJson("release.json") as {
      candidate: {
        release: string;
        build: string;
        executableSha256: string;
        channelIsAdmissionAuthority: boolean;
      };
      runtimeAdmission: {
        status: string;
        directoryImpliesExactBuildPin: boolean;
        productionAdmissionDecision: string;
      };
    };
    expect(release.candidate).toMatchObject({
      release: "1.0.4",
      build: "d846eb93d9",
      executableSha256:
        "79f49625f153923db491a5c290e9b04c3444da488b6b9d6aac533ccb5bff2455",
      channelIsAdmissionAuthority: false,
    });
    expect(release.runtimeAdmission).toEqual(
      expect.objectContaining({
        status: "production-admitted-stable-1.x",
        directoryImpliesExactBuildPin: false,
        productionAdmissionDecision: "stable-1.x-reviewed-floor",
      }),
    );
  });

  it("pins reviewed standard ACP attachment mechanics and model-negative evidence", () => {
    const evidence = readJson("source-image-mechanics.json") as {
      extraction: { claim: string };
      revision: {
        releaseDeclaration: string;
        commit: string;
        sourceRevision: string;
      };
      mechanics: Array<{
        id: string;
        path: string;
        line: number;
        evidenceSha256: string;
      }>;
    };
    expect(evidence.extraction.claim).toContain("not exact-binary");
    expect(evidence.revision).toEqual({
      releaseDeclaration: "1.0.4",
      commit: "5163763e703c319e4554c2f455535c5adb6e51e8",
      sourceRevision: "84ae1223e57a5048afb570d74d45c051fa604982",
    });
    expect(evidence.mechanics.map(({ id }) => id)).toEqual([
      "standard_acp_image_content_ingest",
      "standard_acp_resource_link_ingest",
      "meta_free_resource_link_path_projection",
      "canonical_base64_image_bytes",
      "model_explicit_image_boolean_precedence",
      "model_input_modalities_negative_evidence",
    ]);
    for (const mechanic of evidence.mechanics) {
      expect(mechanic.path).toMatch(/^crates\/codegen\//u);
      expect(mechanic.line).toBeGreaterThan(0);
      expect(mechanic.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("pins source-backed streamed history ordering and load no-replay support", () => {
    const evidence = readJson("source-history-mechanics.json") as {
      extraction: { claim: string };
      revision: {
        releaseDeclaration: string;
        commit: string;
        sourceRevision: string;
      };
      mechanics: Array<{
        id: string;
        path: string;
        line: number;
        evidenceSha256: string;
      }>;
    };
    expect(evidence.extraction.claim).toContain("not exact-binary");
    expect(evidence.revision).toEqual({
      releaseDeclaration: "1.0.4",
      commit: "5163763e703c319e4554c2f455535c5adb6e51e8",
      sourceRevision: "84ae1223e57a5048afb570d74d45c051fa604982",
    });
    expect(evidence.mechanics.map(({ id }) => id)).toEqual([
      "session_updates_stream_request",
      "session_updates_chunk_size_request",
      "session_updates_chunks_before_response",
      "session_update_timestamp_default",
      "session_load_no_replay_meta",
      "session_load_no_replay_policy",
    ]);
    for (const mechanic of evidence.mechanics) {
      expect(mechanic.path).toMatch(/^crates\/codegen\//u);
      expect(mechanic.line).toBeGreaterThan(0);
      expect(mechanic.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("keeps current and prior source candidates explicitly below binary proof", () => {
    const evidence = readJson("source-route-candidates.json") as {
      revisions: Array<{
        role: string;
        commit: string;
        sourceRevision: string;
        claim: string;
        routes: Array<{ route: string }>;
      }>;
    };
    expect(evidence.revisions.map((revision) => revision.commit)).toEqual([
      "5163763e703c319e4554c2f455535c5adb6e51e8",
      "d6a22a1aed70b58d30a0f82a1a2a76ce1301631e",
    ]);
    for (const revision of evidence.revisions) {
      expect(revision.claim).toContain("not exact-binary");
      expect(
        revision.routes.some(({ route }) => route === "x.ai/session/fork"),
      ).toBe(true);
      expect(
        revision.routes.some(({ route }) => route === "x.ai/session/rename"),
      ).toBe(true);
      expect(
        revision.routes.some(
          ({ route }) => route === "x.ai/session/updates/chunk",
        ),
      ).toBe(true);
    }
  });

  it("retains contained evidence and admits the exact production-native profile", () => {
    const profile = readJson("profile.json") as {
      acp: {
        shippingCodec: string;
        productionCapabilityClaims: unknown[];
      };
      tranches: Record<string, { status: string; evidence: string | null }>;
    };
    expect(profile.acp.productionCapabilityClaims).toEqual([
      "native cached-token authentication",
      "model catalog and effective session selection",
      "bounded session-list discovery",
      "provider-assigned session creation",
      "bounded authoritative load replay",
      "ordered text, Task, staged file, and native image submission with durable operation correlation",
      "standard ACP resource links for path-native staged files",
      "standard ACP image content blocks from canonical attachment bytes",
      "restart reconciliation",
      "session close as unload",
    ]);
    expect(profile.acp.shippingCodec).toBe("first-class-stable-1.x");
    expect(profile.tranches).toMatchObject({
      O0: {
        status: "contained-captured",
        evidence: "evidence/o0/capture.json",
      },
      O1: {
        status: "contained-captured",
        evidence: "evidence/o1/capture.json",
        evidenceSha256:
          "7d11c6939ddae0cb498bb155032a90f5d6e65f594587f4130b2c7783618b53b4",
      },
      O2a: {
        status: "contained-captured",
        evidence: "evidence/o2a/capture.json",
        evidenceSha256:
          "7657352425f23f4d1f5dc79ae5543ebae17a906b3efc42e2f84f7283e62809da",
        boundedObservationMilliseconds: 750,
        ignoredNotifications: 1,
        ignoredNotificationBytes: 81,
      },
      O2b: { status: "pending", evidence: null },
      "L-readonly": {
        status: "contained-captured",
        providerCapacity: true,
        authenticated: true,
        evidence: "evidence/l-readonly/capture.json",
        evidenceSha256:
          "ea0e21e316189fe9bb288c132e00a17a110db5ba57194931b0e8a9f4ba3a7c2d",
      },
      L: {
        status: "production-native-suite-passed",
        providerCapacity: true,
        evidence: null,
        suite: "tests/real-grok/grok-session-lifecycle.test.ts",
        verifiedAt: "2026-08-16",
        exactBuild: "d846eb93d9",
      },
    });
    const capture = readJson("evidence/o0/capture.json") as {
      status: string;
      providerCapacity: { used: boolean; enforcement: string[] };
      commands: Array<{
        observation: {
          sandbox: { networkNamespace: boolean; hostRootMounted: boolean };
          cleanup: { ownedProcessGroupTerminated: boolean };
        };
      }>;
      evidenceHistory: { priorDraftUnsandboxedCapture: string };
    };
    expect(capture.status).toBe("contained-captured");
    expect(capture.providerCapacity.used).toBe(false);
    expect(capture.providerCapacity.enforcement).toHaveLength(3);
    expect(capture.commands).toHaveLength(4);
    for (const command of capture.commands) {
      expect(command.observation.sandbox).toMatchObject({
        networkNamespace: true,
        hostRootMounted: false,
      });
      expect(command.observation.cleanup.ownedProcessGroupTerminated).toBe(
        true,
      );
    }
    expect(capture.evidenceHistory.priorDraftUnsandboxedCapture).toBe(
      "replaced-not-retained",
    );

    const o2a = readJson("evidence/o2a/capture.json") as {
      initialize: unknown;
      observation: Record<string, unknown>;
      protocolAdmission: Record<string, unknown>;
      binding: Record<string, unknown>;
      transport: Record<string, unknown>;
    };
    expect(o2a.initialize).toMatchObject({
      protocolVersion: 1,
      agentInfoPresent: false,
      authentication: { kinds: ["agent"], methodCount: 1 },
      capabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
          image: false,
          audio: false,
        },
        session: {
          list: true,
          resume: true,
          close: true,
          fork: false,
          delete: false,
          additionalDirectories: false,
        },
      },
    });
    expect(o2a.observation).toEqual({
      boundedObservationCompleted: true,
      boundedObservationMilliseconds: 750,
      ignoredNotificationBytes: 81,
      ignoredNotifications: 1,
      initializeCompleted: true,
    });
    expect(o2a.protocolAdmission).toMatchObject({
      allowedMethods: ["initialize"],
      authenticate: false,
      filesystemCapability: false,
      providerCapacity: false,
      terminalCapability: false,
    });
    expect(o2a.binding).toMatchObject({
      activeNotifications: 0,
      activeReverseRequests: 0,
      deniedReverseRequests: 0,
      ignoredNotificationBytes: 81,
      ignoredNotifications: 1,
      initialized: true,
      protocolFailures: 0,
    });
    expect(o2a.transport).toMatchObject({
      inboundFramesRead: 2,
      outboundFramesAccepted: 1,
      outboundFramesWritten: 1,
      stderrBytesRead: 0,
      streamsDrained: true,
    });

    const lReadonly = readJson("evidence/l-readonly/capture.json") as {
      authority: Record<string, unknown>;
      initialize: Record<string, unknown>;
      authentication: Record<string, unknown>;
      sessionList: Record<string, unknown>;
      binding: Record<string, unknown>;
      cleanup: Record<string, unknown>;
    };
    expect(lReadonly.authority).toMatchObject({
      credentialFilesStaged: ["auth.json"],
      localCredentialContinuity: {
        singleFreshOidcEntry: true,
        stablePrincipalIdentifierPresent: true,
        contextFieldBasis: ["principalId", "principalType", "teamId"],
        originalCredentialSourceUnchanged: true,
      },
      filesystemCapability: false,
      terminalCapability: false,
      sessionModelToolMutations: false,
    });
    expect(lReadonly.initialize).toEqual({
      protocolVersion: 1,
      cachedTokenAdvertised: true,
      loadSession: true,
      sessionList: true,
      sessionResume: true,
      sessionClose: true,
    });
    expect(lReadonly.authentication).toEqual({
      method: "cached_token",
      completed: true,
    });
    expect(lReadonly.sessionList).toEqual({
      requestedExactDisposableCwd: true,
      sessions: 0,
      nextCursorPresent: false,
    });
    expect(lReadonly.binding).toMatchObject({
      initialized: true,
      ignoredNotifications: 3,
      ignoredNotificationBytes: 723,
      deniedReverseRequests: 0,
      handlerFailures: 0,
      rejectedLateResponses: 0,
      protocolFailures: 0,
    });
    expect(lReadonly.cleanup).toEqual({
      connectionClosed: true,
      assuranceRevoked: true,
      processAndStreamsDrained: true,
      stagedExecutableRemoved: true,
      disposableRootRemoved: true,
    });
  });
});
