import { z } from "zod";
import path from "node:path";
import { isAgentToolCliEndpoint } from "../agent-tool-cli-protocol/local-endpoint.js";
import {
  SidecarOperationError,
  SidecarOperationRegistry,
  defineSidecarOperation,
} from "./operation-registry.js";
import { SIDECAR_WIRE_VERSION } from "./envelopes.js";
import {
  INTERACTIVE_TERMINAL_CAPABILITY_ID,
  INTERACTIVE_TERMINAL_MAJOR_VERSION,
  INTERACTIVE_TERMINAL_V2_EVIDENCE,
} from "./interactive-terminal-v2.js";
import { WORKSPACE_TOOLS_SHELL_V2_LIMITS } from "./workspace-tools-shell-v2.js";
import {
  WORKSPACE_CONTEXT_CAPABILITY_ID,
  WORKSPACE_CONTEXT_MAJOR_VERSION,
  WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
  WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_FILES,
} from "./workspace-context-v1.js";
import {
  WORKSPACE_SKILLS_CAPABILITY_ID,
  WORKSPACE_SKILLS_MAJOR_VERSION,
  WORKSPACE_SKILLS_V1_LIMITS,
} from "./workspace-skills-v1.js";
import {
  WORKSPACE_TOOLS_CAPABILITY_ID,
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES,
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
  WORKSPACE_TOOLS_MAJOR_VERSION,
  WORKSPACE_TOOLS_MAXIMUM_EDITS,
  WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS,
  WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS,
  WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES,
  WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES,
  WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_READ_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_READ_LINES,
  WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES,
} from "./workspace-tools-v2.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.-]*$/u);
const AGENT_TOOLS_CLI_V3_OPERATIONS = Object.freeze([
  "catalog.describe",
  "catalog.list",
  "tool.invoke",
]);

export interface SidecarCapabilityRef {
  readonly capabilityId: string;
  readonly majorVersion: number;
}

export interface SidecarCapabilityInventory extends SidecarCapabilityRef {
  readonly operations: readonly string[];
}

export const sidecarCapabilityRefSchema: z.ZodType<SidecarCapabilityRef> =
  z.strictObject({
    capabilityId: identifierSchema,
    majorVersion: z.number().int().min(1).max(65_535),
  });

export const sidecarCapabilityInventorySchema: z.ZodType<SidecarCapabilityInventory> =
  z.strictObject({
    capabilityId: identifierSchema,
    majorVersion: z.number().int().min(1).max(65_535),
    operations: z.array(identifierSchema).min(1).max(128),
  });

export const sidecarRuntimeEvidenceSchema = z.strictObject({
  os: z.enum(["linux", "darwin", "win32"]),
  architecture: z.enum(["x64", "arm64"]),
});
export type SidecarRuntimeEvidence = z.infer<
  typeof sidecarRuntimeEvidenceSchema
>;

export const workspaceToolsV2CapabilityEvidenceSchema = z.strictObject({
  capabilityId: z.literal(WORKSPACE_TOOLS_CAPABILITY_ID),
  majorVersion: z.literal(WORKSPACE_TOOLS_MAJOR_VERSION),
  limits: z.strictObject({
    maximumPathBytes: z.literal(WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES),
    maximumTextBytes: z.literal(WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES),
    maximumReadBytes: z.literal(WORKSPACE_TOOLS_MAXIMUM_READ_BYTES),
    maximumReadLines: z.literal(WORKSPACE_TOOLS_MAXIMUM_READ_LINES),
    maximumImageBytes: z.literal(WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES),
    maximumEdits: z.literal(WORKSPACE_TOOLS_MAXIMUM_EDITS),
    maximumListEntries: z.literal(WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES),
    maximumFindResults: z.literal(WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS),
    maximumGrepMatches: z.literal(WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES),
    maximumGrepLineCharacters: z.literal(
      WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS,
    ),
    maximumSearchOutputBytes: z.literal(
      WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
    ),
    findScanMaximumEntries: z.literal(
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES,
    ),
    findScanMaximumBytes: z.literal(WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES),
    findScanMaximumMilliseconds: z.literal(
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
    ),
  }),
  streamLimits: z.strictObject({
    maximumInitialCreditBytes: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits.maximumInitialCreditBytes,
    ),
    maximumChunkBytes: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits.maximumChunkBytes,
    ),
    maximumRawOutputBytes: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits.maximumRawOutputBytes,
    ),
    reservedTerminalQueueBytes: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits.reservedTerminalQueueBytes,
    ),
    reservedTerminalQueueFrames: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits.reservedTerminalQueueFrames,
    ),
  }),
  processLimits: z.strictObject({
    maximumProcesses: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits.maximumProcesses,
    ),
    maximumProcessesPerWorkspace: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits
        .maximumProcessesPerWorkspace,
    ),
    maximumDurationMilliseconds: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits.maximumDurationMilliseconds,
    ),
    terminationGraceMilliseconds: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits
        .terminationGraceMilliseconds,
    ),
    drainMilliseconds: z.literal(
      WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits.drainMilliseconds,
    ),
  }),
});

export const workspaceContextV1CapabilityEvidenceSchema = z.strictObject({
  capabilityId: z.literal(WORKSPACE_CONTEXT_CAPABILITY_ID),
  majorVersion: z.literal(WORKSPACE_CONTEXT_MAJOR_VERSION),
  limits: z.strictObject({
    maximumFileBytes: z.literal(WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES),
    maximumAggregateBytes: z.literal(WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES),
    maximumFiles: z.literal(WORKSPACE_CONTEXT_MAXIMUM_FILES),
    maximumDepth: z.literal(WORKSPACE_CONTEXT_MAXIMUM_DEPTH),
  }),
});

export const workspaceSkillsV1CapabilityEvidenceSchema = z.strictObject({
  capabilityId: z.literal(WORKSPACE_SKILLS_CAPABILITY_ID),
  majorVersion: z.literal(WORKSPACE_SKILLS_MAJOR_VERSION),
  limits: z.strictObject({
    maximumFileBytes: z.literal(WORKSPACE_SKILLS_V1_LIMITS.maximumFileBytes),
    maximumSkills: z.literal(WORKSPACE_SKILLS_V1_LIMITS.maximumSkills),
    maximumDiagnostics: z.literal(
      WORKSPACE_SKILLS_V1_LIMITS.maximumDiagnostics,
    ),
    maximumScanEntries: z.literal(
      WORKSPACE_SKILLS_V1_LIMITS.maximumScanEntries,
    ),
    maximumDepth: z.literal(WORKSPACE_SKILLS_V1_LIMITS.maximumDepth),
    maximumCatalogBytes: z.literal(
      WORKSPACE_SKILLS_V1_LIMITS.maximumCatalogBytes,
    ),
  }),
});

export const interactiveTerminalV2CapabilityEvidenceSchema = z.strictObject({
  capabilityId: z.literal(INTERACTIVE_TERMINAL_CAPABILITY_ID),
  majorVersion: z.literal(INTERACTIVE_TERMINAL_MAJOR_VERSION),
  carrier: z.literal(INTERACTIVE_TERMINAL_V2_EVIDENCE.carrier),
  inputAcknowledgement: z.literal(
    INTERACTIVE_TERMINAL_V2_EVIDENCE.inputAcknowledgement,
  ),
  remoteCleanup: z.literal(INTERACTIVE_TERMINAL_V2_EVIDENCE.remoteCleanup),
});

export const sidecarCapabilityEvidenceSchema = z.discriminatedUnion(
  "capabilityId",
  [
    workspaceToolsV2CapabilityEvidenceSchema,
    workspaceContextV1CapabilityEvidenceSchema,
    workspaceSkillsV1CapabilityEvidenceSchema,
    interactiveTerminalV2CapabilityEvidenceSchema,
  ],
);
export type SidecarCapabilityEvidence = z.infer<
  typeof sidecarCapabilityEvidenceSchema
>;

export const sidecarAgentToolCliMetadataSchema = z.strictObject({
  endpoint: z
    .string()
    .min(1)
    .refine(isAgentToolCliEndpoint, "A canonical private local endpoint is required."),
  executableDirectory: z
    .string()
    .min(1)
    .refine(
      validExecutableDirectory,
      "A bounded canonical absolute path is required.",
    ),
  inheritedPath: z
    .string()
    .refine(
      (value) =>
        !containsControl(value) && Buffer.byteLength(value, "utf8") <= 16_384,
      "A bounded PATH without control characters is required.",
    ),
});

export type SidecarAgentToolCliMetadata = z.infer<
  typeof sidecarAgentToolCliMetadataSchema
>;

export interface ControlHelloRequest {
  readonly expectedBuildId: string;
  readonly expectedArtifactSha256: string;
  readonly authorizedSidecarCapabilities: readonly SidecarCapabilityRef[];
  readonly offeredSedesCapabilities: readonly SidecarCapabilityInventory[];
}

export interface ControlHelloResponse {
  readonly wireVersion: typeof SIDECAR_WIRE_VERSION;
  readonly buildId: string;
  readonly artifactSha256: string;
  readonly runtime: SidecarRuntimeEvidence;
  readonly sidecarCapabilities: readonly SidecarCapabilityInventory[];
  readonly capabilityEvidence: readonly SidecarCapabilityEvidence[];
  readonly sedesCapabilities: readonly SidecarCapabilityInventory[];
  readonly agentToolCli?: SidecarAgentToolCliMetadata;
}

export const controlHelloOperation = defineSidecarOperation({
  capabilityId: "control",
  majorVersion: 2,
  operation: "hello",
  lane: "control",
  maximumDeadlineMilliseconds: 10_000,
  requestSchema: z.strictObject({
    expectedBuildId: z.string().min(1).max(200),
    expectedArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    authorizedSidecarCapabilities: z.array(sidecarCapabilityRefSchema).max(32),
    offeredSedesCapabilities: z.array(sidecarCapabilityInventorySchema).max(32),
  }) as z.ZodType<ControlHelloRequest>,
  responseSchema: z.strictObject({
    wireVersion: z.literal(SIDECAR_WIRE_VERSION),
    buildId: z.string().min(1).max(200),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    runtime: sidecarRuntimeEvidenceSchema,
    sidecarCapabilities: z.array(sidecarCapabilityInventorySchema).max(32),
    capabilityEvidence: z.array(sidecarCapabilityEvidenceSchema).max(32),
    sedesCapabilities: z.array(sidecarCapabilityInventorySchema).max(32),
    agentToolCli: sidecarAgentToolCliMetadataSchema.optional(),
  }) as z.ZodType<ControlHelloResponse>,
});

export const controlPingOperation = defineSidecarOperation({
  capabilityId: "control",
  majorVersion: 2,
  operation: "ping",
  lane: "control",
  maximumDeadlineMilliseconds: 5_000,
  requestSchema: z.strictObject({ pingId: z.string().uuid() }),
  responseSchema: z.strictObject({ pingId: z.string().uuid() }),
});

export const controlGoAwayOperation = defineSidecarOperation({
  capabilityId: "control",
  majorVersion: 2,
  operation: "go_away",
  lane: "control",
  maximumDeadlineMilliseconds: 5_000,
  requestSchema: z.strictObject({
    reason: z.string().min(1).max(120),
  }),
  responseSchema: z.strictObject({ accepted: z.literal(true) }),
});

export interface ControlV2Registration {
  readonly buildId: string;
  readonly artifactSha256: string;
  readonly enabledSidecarCapabilities: readonly SidecarCapabilityRef[];
  readonly enabledSedesCapabilities: readonly SidecarCapabilityInventory[];
  readonly runtime?: SidecarRuntimeEvidence;
  readonly capabilityEvidence?: readonly SidecarCapabilityEvidence[];
  readonly prepareSedesCapabilities?: (input: {
    readonly sedesCapabilities: readonly SidecarCapabilityInventory[];
    readonly signal: AbortSignal;
  }) => Promise<SidecarAgentToolCliMetadata> | SidecarAgentToolCliMetadata;
  readonly onGoAway?: (reason: string) => void | Promise<void>;
}

/** Registers the sidecar-owned half of the asymmetric session handshake. */
export function registerControlV2Operations(
  registry: SidecarOperationRegistry,
  registration: ControlV2Registration,
): void {
  validateRegistration(registration);
  const enabledSidecar = capabilityKeys(
    registration.enabledSidecarCapabilities,
  );
  const enabledSedes = capabilityInventories(
    registration.enabledSedesCapabilities,
  );
  const runtime = sidecarRuntimeEvidenceSchema.parse(
    registration.runtime ?? {
      os: process.platform,
      architecture: process.arch,
    },
  );
  const configuredEvidence = capabilityEvidence(
    registration.capabilityEvidence ?? [],
    enabledSidecar,
  );
  registry.register(controlHelloOperation, async (request, context) => {
    if (
      request.expectedBuildId !== registration.buildId ||
      request.expectedArtifactSha256 !== registration.artifactSha256
    ) {
      throw new SidecarOperationError("sidecar_build_identity_mismatch");
    }
    const authorizedSidecar = capabilityKeys(
      request.authorizedSidecarCapabilities,
    );
    const requestedSidecarCapabilities = request.authorizedSidecarCapabilities
      .filter((capability) => enabledSidecar.has(capabilityKey(capability)))
      .sort(
        (left, right) =>
          left.capabilityId.localeCompare(right.capabilityId) ||
          left.majorVersion - right.majorVersion,
      );
    const requestedPairKeys = requestedSidecarCapabilities
      .filter(isWorkspaceToolsOrContext)
      .map(capabilityKey);
    if (requestedPairKeys.length > 0) {
      if (
        requestedPairKeys.length !== 2 ||
        !requestedPairKeys.includes(WORKSPACE_TOOLS_KEY) ||
        !requestedPairKeys.includes(WORKSPACE_CONTEXT_KEY) ||
        !configuredEvidence.has(WORKSPACE_TOOLS_KEY) ||
        !configuredEvidence.has(WORKSPACE_CONTEXT_KEY)
      ) {
        throw new SidecarOperationError("sidecar_capability_mismatch");
      }
    }
    if (
      requestedSidecarCapabilities.some(
        (capability) => capabilityKey(capability) === INTERACTIVE_TERMINAL_KEY,
      ) &&
      !configuredEvidence.has(INTERACTIVE_TERMINAL_KEY)
    ) {
      throw new SidecarOperationError("sidecar_capability_mismatch");
    }
    const offeredSedes = new Map(
      request.offeredSedesCapabilities.map((capability) => [
        capabilityKey(capability),
        capability,
      ]),
    );
    const sedesCapabilities = [...enabledSedes.entries()]
      .flatMap(([key, expected]) => {
        const offered = offeredSedes.get(key);
        if (!offered) return [];
        if (!equalOperations(offered.operations, expected.operations)) {
          throw new SidecarOperationError("sidecar_sedes_capability_mismatch");
        }
        return [offered];
      })
      .sort(compareCapabilities);
    const agentToolCliAccepted = sedesCapabilities.some(
      (capability) =>
        capability.capabilityId === "agent_tools_cli" &&
        capability.majorVersion === 3,
    );
    if (agentToolCliAccepted && !registration.prepareSedesCapabilities) {
      throw new SidecarOperationError("sidecar_agent_tool_cli_not_ready");
    }
    const agentToolCli = agentToolCliAccepted
      ? sidecarAgentToolCliMetadataSchema.parse(
          await registration.prepareSedesCapabilities!({
            sedesCapabilities,
            signal: context.signal,
          }),
        )
      : undefined;
    const sidecarCapabilities = registry
      .capabilities()
      .filter(
        (capability) =>
          capability.capabilityId === "control" ||
          (enabledSidecar.has(capabilityKey(capability)) &&
            authorizedSidecar.has(capabilityKey(capability))),
      );
    return {
      wireVersion: SIDECAR_WIRE_VERSION,
      buildId: registration.buildId,
      artifactSha256: registration.artifactSha256,
      runtime,
      sidecarCapabilities,
      capabilityEvidence: [...configuredEvidence.values()]
        .filter((item) =>
          sidecarCapabilities.some(
            (capability) => capabilityKey(capability) === capabilityKey(item),
          ),
        )
        .sort(
          (left, right) =>
            left.capabilityId.localeCompare(right.capabilityId) ||
            left.majorVersion - right.majorVersion,
        ),
      sedesCapabilities,
      ...(agentToolCli ? { agentToolCli } : {}),
    };
  });
  registry.register(controlPingOperation, ({ pingId }) => ({ pingId }));
  registry.register(controlGoAwayOperation, async ({ reason }) => {
    await registration.onGoAway?.(reason);
    return { accepted: true as const };
  });
}

function validateRegistration(registration: ControlV2Registration): void {
  if (
    !registration.buildId ||
    registration.buildId.length > 200 ||
    !/^[0-9a-f]{64}$/u.test(registration.artifactSha256) ||
    registration.enabledSidecarCapabilities.length > 32 ||
    registration.enabledSedesCapabilities.length > 32
  ) {
    throw new Error("sidecar_control_registration_invalid");
  }
  capabilityKeys(registration.enabledSidecarCapabilities);
  capabilityInventories(registration.enabledSedesCapabilities);
  capabilityEvidence(
    registration.capabilityEvidence ?? [],
    capabilityKeys(registration.enabledSidecarCapabilities),
  );
}

function capabilityEvidence(
  values: readonly SidecarCapabilityEvidence[],
  enabled: ReadonlySet<string>,
): ReadonlyMap<string, SidecarCapabilityEvidence> {
  const result = new Map<string, SidecarCapabilityEvidence>();
  for (const value of values) {
    const parsed = sidecarCapabilityEvidenceSchema.parse(value);
    const key = capabilityKey(parsed);
    if (!enabled.has(key) || result.has(key)) {
      throw new Error("sidecar_control_registration_invalid");
    }
    result.set(key, parsed);
  }
  return result;
}

const WORKSPACE_TOOLS_KEY = `${WORKSPACE_TOOLS_CAPABILITY_ID}\0${WORKSPACE_TOOLS_MAJOR_VERSION}`;
const WORKSPACE_CONTEXT_KEY = `${WORKSPACE_CONTEXT_CAPABILITY_ID}\0${WORKSPACE_CONTEXT_MAJOR_VERSION}`;
const WORKSPACE_SKILLS_KEY = `${WORKSPACE_SKILLS_CAPABILITY_ID}\0${WORKSPACE_SKILLS_MAJOR_VERSION}`;
const INTERACTIVE_TERMINAL_KEY = `${INTERACTIVE_TERMINAL_CAPABILITY_ID}\0${INTERACTIVE_TERMINAL_MAJOR_VERSION}`;

function isWorkspaceToolsOrContext(capability: SidecarCapabilityRef): boolean {
  const key = capabilityKey(capability);
  return key === WORKSPACE_TOOLS_KEY || key === WORKSPACE_CONTEXT_KEY;
}

/** Main-host validation of exact runtime and evidence for the authorized set. */
export function validateSidecarHelloCapabilityEvidence(
  hello: Pick<
    ControlHelloResponse,
    "runtime" | "sidecarCapabilities" | "capabilityEvidence"
  >,
  authorizedCapabilities: readonly SidecarCapabilityRef[],
): void {
  sidecarRuntimeEvidenceSchema.parse(hello.runtime);
  const authorized = capabilityKeys(authorizedCapabilities);
  const advertised = new Set(
    hello.sidecarCapabilities
      .filter((capability) => capability.capabilityId !== "control")
      .map(capabilityKey),
  );
  const evidence = new Map<string, SidecarCapabilityEvidence>();
  for (const value of hello.capabilityEvidence) {
    const parsed = sidecarCapabilityEvidenceSchema.parse(value);
    const key = capabilityKey(parsed);
    if (!authorized.has(key) || !advertised.has(key) || evidence.has(key)) {
      throw new Error("sidecar_capability_mismatch");
    }
    evidence.set(key, parsed);
  }
  for (const key of [
    WORKSPACE_TOOLS_KEY,
    WORKSPACE_CONTEXT_KEY,
    WORKSPACE_SKILLS_KEY,
    INTERACTIVE_TERMINAL_KEY,
  ]) {
    if (authorized.has(key) && advertised.has(key) !== evidence.has(key)) {
      throw new Error("sidecar_capability_mismatch");
    }
  }
}

function capabilityKeys(
  capabilities: readonly SidecarCapabilityRef[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const capability of capabilities) {
    const parsed = sidecarCapabilityRefSchema.parse(capability);
    if (parsed.capabilityId === "control") {
      throw new Error("sidecar_control_registration_invalid");
    }
    const key = capabilityKey(parsed);
    if (keys.has(key)) throw new Error("sidecar_capability_duplicate");
    keys.add(key);
  }
  return keys;
}

function capabilityKey(input: SidecarCapabilityRef): string {
  return `${input.capabilityId}\0${input.majorVersion}`;
}

function capabilityInventories(
  capabilities: readonly SidecarCapabilityInventory[],
): ReadonlyMap<string, SidecarCapabilityInventory> {
  const result = new Map<string, SidecarCapabilityInventory>();
  for (const capability of capabilities) {
    const parsed = sidecarCapabilityInventorySchema.parse(capability);
    if (parsed.capabilityId === "control") {
      throw new Error("sidecar_control_registration_invalid");
    }
    const key = capabilityKey(parsed);
    if (
      result.has(key) ||
      !canonicalOperations(parsed.operations) ||
      (parsed.capabilityId === "agent_tools_cli" &&
        (parsed.majorVersion !== 3 ||
          !equalOperations(parsed.operations, AGENT_TOOLS_CLI_V3_OPERATIONS)))
    ) {
      throw new Error("sidecar_control_registration_invalid");
    }
    result.set(key, parsed);
  }
  return result;
}

function canonicalOperations(operations: readonly string[]): boolean {
  return (
    new Set(operations).size === operations.length &&
    equalOperations(operations, [...operations].sort())
  );
}

function equalOperations(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((operation, index) => operation === right[index])
  );
}

function compareCapabilities(
  left: SidecarCapabilityInventory,
  right: SidecarCapabilityInventory,
): number {
  return (
    left.capabilityId.localeCompare(right.capabilityId) ||
    left.majorVersion - right.majorVersion
  );
}

function validExecutableDirectory(value: string): boolean {
  return (
    ((path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.includes("\\")) ||
      (/^[A-Za-z]:\\/u.test(value) && path.win32.normalize(value) === value)) &&
    !containsControl(value) &&
    Buffer.byteLength(value, "utf8") <= 4_096
  );
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
