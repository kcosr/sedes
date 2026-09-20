import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

export const GROK_PROBE_MODES = Object.freeze({
  O1_NO_INITIALIZE: "o1_no_initialize",
  O2A_INITIALIZE_ONLY: "o2a_initialize_only",
  O2B_OFFLINE: "o2b_offline",
});

const MODE_VALUES = new Set(Object.values(GROK_PROBE_MODES));
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 4_000,
  observationMs: 350,
  terminateGraceMs: 300,
  killGraceMs: 1_000,
  maxStdoutBytes: 256 * 1024,
  maxStderrBytes: 64 * 1024,
  maxFrameBytes: 64 * 1024,
  maxFrames: 128,
  maxFilesystemEntries: 512,
  maxFilesystemBytes: 4 * 1024 * 1024,
  maxManifestFileBytes: 256 * 1024,
  maxManifestDepth: 12,
});
const SAFE_ENVIRONMENT_NAMES = new Set(["LANG", "LC_ALL", "TZ"]);
export const GROK_O2B_SCENARIO_MANIFEST_URL = new URL(
  "./grok-o2b-scenarios.json",
  import.meta.url,
);
const SAFE_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_RELATIVE_TARGET = /^[a-zA-Z0-9._/-]+$/u;
const INPUT_KEYS = new Set([
  "mode",
  "executablePath",
  "retainedFileDescriptor",
  "expectedSha256",
  "expectedBytes",
  "scriptPath",
  "bubblewrapPath",
  "arguments",
  "environment",
  "sensitiveValues",
  "inputFrames",
  "offlineScenarioIds",
  "o2aReviewEvidence",
  "limits",
  "signal",
]);
const EXACT_GROK_STDIO_ARGUMENTS = Object.freeze([
  "--no-auto-update",
  "agent",
  "--no-leader",
  "stdio",
]);
const STATIC_COMMANDS = Object.freeze({
  version_json: Object.freeze(["version", "--json"]),
  root_help: Object.freeze(["--help"]),
  agent_help: Object.freeze(["agent", "--help"]),
  agent_stdio_help: Object.freeze(["agent", "stdio", "--help"]),
});
const STATIC_INPUT_KEYS = new Set([
  "executablePath",
  "retainedFileDescriptor",
  "expectedSha256",
  "expectedBytes",
  "command",
  "bubblewrapPath",
  "limits",
  "signal",
]);
const AMBIENT_MARKER = "sedes-grok-probe-ambient-marker-v1";

export class GrokProbeSandboxError extends Error {
  constructor(code, message, result, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GrokProbeSandboxError";
    this.code = code;
    this.result = result;
  }
}

export async function assertGrokProbeSandboxAvailable(
  bubblewrapPath = "/usr/bin/bwrap",
  signal,
) {
  validateAbortSignal(signal)?.throwIfAborted();
  const resolved = await resolveRegularFile(bubblewrapPath, "bubblewrapPath");
  signal?.throwIfAborted();
  const result = await runCommand(resolved, ["--version"], 2_000, signal);
  signal?.throwIfAborted();
  if (result.code !== 0 || result.signal !== null) {
    throw new GrokProbeSandboxError(
      "bubblewrap_unavailable",
      `bubblewrap preflight failed: ${boundedText(result.stderr, 512)}`,
    );
  }
  return { path: resolved, version: boundedText(result.stdout.trim(), 128) };
}

/**
 * Builds one fresh sandbox launch plan for composition with
 * LocalEnvironmentChannelProvider and OwnedNdjsonStdioTransportFactory. This
 * function does not spawn, frame, parse, or close the provider process; the
 * shared assured transport and AcpBinding remain the sole production owners of
 * those responsibilities.
 */
export async function createGrokProbeSandboxLaunchPlan(input) {
  const immutableInput = Object.freeze({ ...input });
  validateAbortSignal(immutableInput.signal)?.throwIfAborted();
  const validated = await validateInput(immutableInput, { launchPlan: true });
  return await createSandboxLaunchPlan(
    validated,
    Object.freeze({
      maximumOutboundFrames:
        validated.mode === GROK_PROBE_MODES.O1_NO_INITIALIZE
          ? 0
          : validated.mode === GROK_PROBE_MODES.O2A_INITIALIZE_ONLY
            ? 1
            : validated.offlineMethodAllowlist.length + 1,
      ...(validated.mode === GROK_PROBE_MODES.O2A_INITIALIZE_ONLY
        ? {
            maximumInboundFrames: 2,
          }
        : {}),
      allowedMethods: Object.freeze(
        validated.mode === GROK_PROBE_MODES.O1_NO_INITIALIZE
          ? []
          : validated.mode === GROK_PROBE_MODES.O2A_INITIALIZE_ONLY
            ? ["initialize"]
            : ["initialize", ...validated.offlineMethodAllowlist],
      ),
      authenticate: false,
      providerCapacity: false,
      filesystemCapability: false,
      terminalCapability: false,
    }),
    validated.scriptPath === undefined
      ? async (signal) => {
          await verifyStagedExecutable(immutableInput, signal);
        }
      : undefined,
  );
}

/**
 * Builds a no-ACP O0 launch plan for one closed static command against a
 * profile-owned, already verified private staged executable.
 */
export async function createGrokStaticProbeSandboxLaunchPlan(input) {
  const immutableInput = Object.freeze({ ...input });
  validateAbortSignal(immutableInput.signal)?.throwIfAborted();
  const validated = await validateStaticPlanInput(immutableInput);
  return await createSandboxLaunchPlan(
    validated,
    Object.freeze({
      maximumOutboundFrames: 0,
      allowedMethods: Object.freeze([]),
      authenticate: false,
      providerCapacity: false,
      filesystemCapability: false,
      terminalCapability: false,
    }),
    async (signal) => {
      await verifyStagedExecutable(immutableInput, signal);
    },
  );
}

async function createSandboxLaunchPlan(validated, protocolAdmission, reverify) {
  validated.signal?.throwIfAborted();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "sedes-grok-probe-plan-"),
  );
  const sandboxRoot = path.join(temporaryRoot, "sandbox");
  const mounts = sandboxMounts(sandboxRoot);
  const canaries = [
    `grok-probe-secret-${randomBytes(24).toString("hex")}`,
    ...(validated.sensitiveValues ?? []),
  ];
  const hostCanaryPath = path.join(temporaryRoot, "host-only-secret");
  let finalizePromise;
  try {
    await createSandboxDirectories(mounts);
    validated.signal?.throwIfAborted();
    await writeFile(hostCanaryPath, `${canaries[0]}\n`, { mode: 0o600 });
    await seedAmbientCanaries(mounts, AMBIENT_MARKER);
    const before = await createManifest(
      sandboxRoot,
      validated.limits,
      validated.signal,
    );
    const context = {
      ...validated,
      temporaryRoot,
      sandboxRoot,
      mounts,
      hostCanaryPath,
      canaries,
      before,
    };
    const finalize = (options = {}) => {
      if (
        options === null ||
        typeof options !== "object" ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== "signal")
      ) {
        throw new TypeError("Grok probe finalize options are invalid");
      }
      const finalizeSignal = combineAbortSignals(
        validated.signal,
        validateAbortSignal(options.signal),
      );
      finalizePromise ??= (async () => {
        let result;
        try {
          finalizeSignal?.throwIfAborted();
          await reverify?.(finalizeSignal);
          finalizeSignal?.throwIfAborted();
          const after = await createManifest(
            sandboxRoot,
            validated.limits,
            finalizeSignal,
          );
          result = Object.freeze({
            filesystem: {
              before: redactValue(before, canaries),
              after: redactValue(after, canaries),
              changes: redactValue(manifestChanges(before, after), canaries),
            },
            cleanup: {
              temporaryRootRemoved: true,
            },
          });
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
        return result;
      })();
      return finalizePromise;
    };
    return Object.freeze({
      mode: validated.mode,
      launch: Object.freeze({
        executablePath: validated.bubblewrap.path,
        workingDirectory: "/",
        commandArguments: Object.freeze(buildBubblewrapCommand(context)),
        environment: Object.freeze({}),
        inheritedFileDescriptors:
          validated.fixtureRuntime
            ? Object.freeze([])
            : Object.freeze([
                Object.freeze({
                  sourceFd: validated.retainedFileDescriptor,
                  targetFd: 3,
                  disposition: "read_only_executable_bytes",
                }),
              ]),
        sensitiveValues: Object.freeze([...canaries]),
      }),
      protocolAdmission,
      writableMounts: Object.freeze({
        home: "/home/probe",
        grokHome: "/home/probe/.grok",
        workspace: "/mnt/workspace",
        tmp: "/tmp",
      }),
      filesystemBefore: redactValue(before, canaries),
      finalize,
    });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs one credential-free Grok characterization scenario inside a fresh
 * rootless bubblewrap boundary. It intentionally exposes no authentication or
 * provider-capacity mode. Raw stdout, stderr, and secret canaries live only in
 * the removed invocation directory; returned observations are redacted.
 */
export async function runGrokProbe(input) {
  const validated = await validateInput(input);
  if (validated.scriptPath === undefined) {
    throw new TypeError(
      "runGrokProbe is fixture-only; exact binaries use createGrokProbeSandboxLaunchPlan with the shared owned transport",
    );
  }
  return await runValidatedSandbox({ ...validated, outputFormat: "ndjson" });
}

/** Runs one of the four no-ACP O0 commands with bounded raw text capture. */
export async function runGrokStaticProbe(input) {
  const immutableInput = Object.freeze({ ...input });
  const validated = await validateStaticPlanInput(immutableInput);
  const result = await runValidatedSandbox({ ...validated, outputFormat: "raw" });
  try {
    await verifyStagedExecutable(immutableInput);
  } catch (error) {
    throw new GrokProbeSandboxError(
      "staged_executable_identity_mismatch",
      "Static Grok staged path no longer identifies the retained executable",
      result,
      error,
    );
  }
  return result;
}

async function runValidatedSandbox(validated) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "sedes-grok-probe-"),
  );
  const sandboxRoot = path.join(temporaryRoot, "sandbox");
  const rawRoot = path.join(temporaryRoot, "raw");
  const mounts = sandboxMounts(sandboxRoot);
  const canaries = [
    `grok-probe-secret-${randomBytes(24).toString("hex")}`,
    ...(validated.sensitiveValues ?? []),
  ];
  const hostCanaryPath = path.join(temporaryRoot, "host-only-secret");
  let result;
  let cleanupError;

  try {
    await Promise.all([
      createSandboxDirectories(mounts),
      mkdir(rawRoot, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(hostCanaryPath, `${canaries[0]}\n`, { mode: 0o600 });
    await seedAmbientCanaries(mounts, AMBIENT_MARKER);
    const before = await createManifest(sandboxRoot, validated.limits);
    result = await executeSandbox({
      ...validated,
      temporaryRoot,
      sandboxRoot,
      rawRoot,
      mounts,
      hostCanaryPath,
      canaries,
      before,
    });
    return result;
  } catch (error) {
    if (error instanceof GrokProbeSandboxError) throw error;
    throw new GrokProbeSandboxError(
      "probe_failed",
      "Grok probe sandbox failed",
      result,
      error,
    );
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      await access(temporaryRoot)
        .then(() => {
          throw new Error("temporary_root_still_exists");
        })
        .catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      throw new GrokProbeSandboxError(
        "temporary_cleanup_failed",
        "Grok probe temporary directory could not be removed",
        result,
        cleanupError,
      );
    }
  }
}

async function validateInput(input, options = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Grok probe input must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key))
      throw new TypeError(`Unknown Grok probe input: ${key}`);
  }
  if (!MODE_VALUES.has(input.mode)) {
    throw new TypeError(`Unsupported Grok probe mode: ${String(input.mode)}`);
  }
  const signal = validateAbortSignal(input.signal);
  signal?.throwIfAborted();
  const executablePath = await resolveRegularFile(
    input.executablePath,
    "executablePath",
  );
  const scriptPath =
    input.scriptPath === undefined
      ? undefined
      : await resolveRegularFile(input.scriptPath, "scriptPath");
  const bubblewrapPath =
    input.bubblewrapPath === undefined
      ? "/usr/bin/bwrap"
      : input.bubblewrapPath;
  const bubblewrap = await assertGrokProbeSandboxAvailable(bubblewrapPath, signal);
  const args = validateStringArray(
    input.arguments ?? [],
    "arguments",
    64,
    4096,
  );
  if (
    options.launchPlan === true &&
    scriptPath === undefined &&
    (args.length !== EXACT_GROK_STDIO_ARGUMENTS.length ||
      args.some(
        (argument, index) => argument !== EXACT_GROK_STDIO_ARGUMENTS[index],
      ))
  ) {
    throw new TypeError(
      "Exact-binary probes require the closed no-update/no-leader Grok stdio command",
    );
  }
  let executableMountSource = executablePath;
  let retainedFileDescriptor;
  if (options.launchPlan === true && scriptPath === undefined) {
    retainedFileDescriptor = await verifyStagedExecutable(input, signal);
  } else if (
    input.retainedFileDescriptor !== undefined ||
    input.expectedSha256 !== undefined ||
    input.expectedBytes !== undefined
  ) {
    throw new TypeError(
      "Retained executable identity fields are valid only for exact launch plans",
    );
  }
  const environment = validateEnvironment(input.environment ?? {});
  const sensitiveValues = validateStringArray(
    input.sensitiveValues ?? [],
    "sensitiveValues",
    32,
    4096,
  ).filter((value) => value.length >= 8);
  const offlineAdmission = await resolveO2bAdmission(input);
  let inputFrames;
  if (options.launchPlan === true) {
    if (
      input.inputFrames !== undefined &&
      (!Array.isArray(input.inputFrames) || input.inputFrames.length !== 0)
    ) {
      throw new TypeError(
        "Launch plans do not accept inputFrames; AcpBinding is the sole protocol writer",
      );
    }
    validatePlanAdmission(input.mode, offlineAdmission);
    inputFrames = [];
  } else {
    inputFrames = validateFrames(
      input.mode,
      input.inputFrames ?? [],
      offlineAdmission,
    );
  }
  const limits = validateLimits(input.limits ?? {});
  return {
    mode: input.mode,
    executablePath,
    executableMountSource,
    retainedFileDescriptor,
    scriptPath,
    bubblewrap,
    arguments: args,
    environment,
    sensitiveValues,
    inputFrames,
    offlineScenarioIds: offlineAdmission.scenarioIds,
    offlineMethodAllowlist: offlineAdmission.methods,
    limits,
    fixtureRuntime: scriptPath !== undefined,
    exposeTemporaryIdentity: true,
    signal,
  };
}

async function validateStaticPlanInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Static Grok probe input must be an object");
  }
  for (const key of Object.keys(input)) {
    if (!STATIC_INPUT_KEYS.has(key)) {
      throw new TypeError(`Unknown static Grok probe input: ${key}`);
    }
  }
  const signal = validateAbortSignal(input.signal);
  signal?.throwIfAborted();
  const commandArguments =
    typeof input.command === "string" && Object.hasOwn(STATIC_COMMANDS, input.command)
      ? STATIC_COMMANDS[input.command]
      : undefined;
  if (commandArguments === undefined) {
    throw new TypeError(`Unsupported static Grok probe command: ${String(input.command)}`);
  }
  const retainedFileDescriptor = await verifyStagedExecutable(input, signal);
  const bubblewrap = await assertGrokProbeSandboxAvailable(
    input.bubblewrapPath ?? "/usr/bin/bwrap",
    signal,
  );
  return {
    mode: `o0_${input.command}`,
    executablePath: input.executablePath,
    executableMountSource: undefined,
    retainedFileDescriptor,
    scriptPath: undefined,
    bubblewrap,
    arguments: [...commandArguments],
    environment: {},
    sensitiveValues: [],
    inputFrames: [],
    offlineMethodAllowlist: [],
    limits: validateLimits(input.limits ?? {}),
    fixtureRuntime: false,
    exposeTemporaryIdentity: false,
    signal,
  };
}

async function verifyStagedExecutable(input, signal = input.signal) {
  validateAbortSignal(signal)?.throwIfAborted();
  if (
    typeof input.executablePath !== "string" ||
    !path.isAbsolute(input.executablePath) ||
    path.resolve(input.executablePath) !== input.executablePath
  ) {
    throw new TypeError("Static Grok executablePath must be a canonical absolute path");
  }
  if (
    typeof input.expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.expectedSha256)
  ) {
    throw new TypeError("Static Grok expectedSha256 must be lowercase SHA-256");
  }
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes <= 0) {
    throw new TypeError("Static Grok expectedBytes must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(input.retainedFileDescriptor) ||
    input.retainedFileDescriptor < 0
  ) {
    throw new TypeError(
      "Static Grok retainedFileDescriptor must be an open nonnegative fd",
    );
  }
  const retainedPath = `/proc/self/fd/${input.retainedFileDescriptor}`;
  const parent = path.dirname(input.executablePath);
  const [parentBefore, executableBefore, retainedBefore] = await Promise.all([
    lstat(parent, { bigint: true }),
    lstat(input.executablePath, { bigint: true }),
    stat(retainedPath, { bigint: true }),
  ]);
  signal?.throwIfAborted();
  if (
    !parentBefore.isDirectory() ||
    Number(parentBefore.mode & 0o777n) !== 0o700 ||
    (await realpath(parent)) !== parent
  ) {
    throw new TypeError("Static Grok staged parent must be canonical mode 0700");
  }
  if (
    !executableBefore.isFile() ||
    executableBefore.isSymbolicLink() ||
    Number(executableBefore.mode & 0o777n) !== 0o500 ||
    Number(executableBefore.size) !== input.expectedBytes ||
    (await realpath(input.executablePath)) !== input.executablePath ||
    !sameFileObject(executableBefore, retainedBefore)
  ) {
    throw new TypeError(
      "Static Grok staged executable must be canonical regular mode 0500 with expected size",
    );
  }
  const digest = await sha256Stream(retainedPath, signal);
  const [executableAfter, retainedAfter] = await Promise.all([
    lstat(input.executablePath, { bigint: true }),
    stat(retainedPath, { bigint: true }),
  ]);
  signal?.throwIfAborted();
  if (
    digest !== input.expectedSha256 ||
    !sameFileSnapshot(executableBefore, executableAfter) ||
    !sameFileSnapshot(retainedBefore, retainedAfter) ||
    !sameFileObject(executableAfter, retainedAfter)
  ) {
    throw new GrokProbeSandboxError(
      "staged_executable_identity_mismatch",
      "Static Grok staged executable changed or failed digest verification",
    );
  }
  return input.retainedFileDescriptor;
}

function sameFileObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function sha256Stream(file, signal) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) {
    signal?.throwIfAborted();
    digest.update(chunk);
  }
  signal?.throwIfAborted();
  return digest.digest("hex");
}

async function resolveO2bAdmission(input) {
  if (input.mode !== GROK_PROBE_MODES.O2B_OFFLINE) {
    if (input.offlineScenarioIds !== undefined || input.o2aReviewEvidence !== undefined) {
      throw new TypeError("O2b scenario admission is valid only for O2b");
    }
    return { scenarioIds: [], methods: [] };
  }
  const scenarioIds = validateStringArray(
    input.offlineScenarioIds ?? [],
    "offlineScenarioIds",
    1,
    100,
  );
  if (scenarioIds.length !== 1) {
    throw new TypeError("O2b requires exactly one reviewed scenario per sandbox");
  }
  const evidence = input.o2aReviewEvidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).some((key) => !["status", "evidenceId"].includes(key)) ||
    evidence.status !== "accepted" ||
    typeof evidence.evidenceId !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,200}$/u.test(evidence.evidenceId)
  ) {
    throw new TypeError("O2b requires accepted bounded O2a review evidence");
  }
  const scenarios = await loadReviewedO2bScenarios();
  const scenario = scenarios.get(scenarioIds[0]);
  if (scenario === undefined) {
    throw new TypeError(`Unknown reviewed O2b scenario: ${scenarioIds[0]}`);
  }
  return { scenarioIds, methods: [scenario.method] };
}

async function loadReviewedO2bScenarios() {
  const value = JSON.parse(await readFile(GROK_O2B_SCENARIO_MANIFEST_URL, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.profile !== "grok-source-probe-v1" ||
    value.o2aGate !== "review_required" ||
    !Array.isArray(value.scenarios) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "profile", "o2aGate", "scenarios"].includes(key),
    )
  ) {
    throw new TypeError("Reviewed O2b scenario manifest is invalid");
  }
  const scenarios = new Map();
  for (const scenario of value.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== "object" ||
      Array.isArray(scenario) ||
      Object.keys(scenario).some(
        (key) =>
          !["scenarioId", "method", "status", "initializeFirst", "schemaId"].includes(
            key,
          ),
      ) ||
      typeof scenario.scenarioId !== "string" ||
      !/^[a-z0-9_]{1,100}$/u.test(scenario.scenarioId) ||
      typeof scenario.method !== "string" ||
      !/^x\.ai\/[a-z0-9_/-]{1,200}$/u.test(scenario.method) ||
      scenario.status !== "source_characterization_only" ||
      scenario.initializeFirst !== true ||
      typeof scenario.schemaId !== "string" ||
      !/^[a-z0-9_]{1,100}$/u.test(scenario.schemaId) ||
      scenarios.has(scenario.scenarioId)
    ) {
      throw new TypeError("Reviewed O2b scenario manifest entry is invalid");
    }
    scenarios.set(scenario.scenarioId, Object.freeze({ ...scenario }));
  }
  if (scenarios.size === 0) {
    throw new TypeError("Reviewed O2b scenario manifest is empty");
  }
  return scenarios;
}

function validatePlanAdmission(mode, offlineAdmission) {
  if (mode === GROK_PROBE_MODES.O2B_OFFLINE) {
    if (offlineAdmission.scenarioIds.length !== 1 || offlineAdmission.methods.length !== 1) {
      throw new TypeError("O2b reviewed scenario admission is incomplete");
    }
  } else if (
    offlineAdmission.scenarioIds.length !== 0 ||
    offlineAdmission.methods.length !== 0
  ) {
    throw new TypeError("O2b scenario admission is valid only for O2b");
  }
}

function validateFrames(mode, frames, offlineAdmission) {
  if (!Array.isArray(frames))
    throw new TypeError("inputFrames must be an array");
  if (mode === GROK_PROBE_MODES.O1_NO_INITIALIZE && frames.length !== 0) {
    throw new TypeError("O1 forbids all ACP input, including initialize");
  }
  if (mode === GROK_PROBE_MODES.O2A_INITIALIZE_ONLY) {
    const label = "O2a";
    if (frames.length !== 1 || frames[0]?.method !== "initialize") {
      throw new TypeError(
        `${label} requires exactly one initialize request`,
      );
    }
    validateInitializeFrame(frames[0], label);
  }
  if (mode === GROK_PROBE_MODES.O2B_OFFLINE) {
    validatePlanAdmission(mode, offlineAdmission);
    if (
      frames.length !== 2 ||
      frames[0]?.method !== "initialize" ||
      frames[1]?.method !== offlineAdmission.methods[0]
    ) {
      throw new TypeError(
        "O2b requires initialize followed by its one exact reviewed scenario",
      );
    }
    validateInitializeFrame(frames[0], "O2b");
  }
  return frames.map((frame, index) => {
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      throw new TypeError(`inputFrames[${index}] must be an object`);
    }
    const serialized = JSON.stringify(frame);
    if (serialized === undefined) {
      throw new TypeError(`inputFrames[${index}] is not JSON serializable`);
    }
    return { value: structuredClone(frame), serialized };
  });
}

function validateInitializeFrame(frame, label) {
    if (
      frame?.jsonrpc !== "2.0" ||
      !(typeof frame?.id === "string" || Number.isSafeInteger(frame?.id)) ||
      frame?.params === null ||
      typeof frame?.params !== "object" ||
      Array.isArray(frame?.params)
    ) {
      throw new TypeError(`${label} initialize must be one JSON-RPC 2.0 request`);
    }
    const capabilities =
      frame.params.clientCapabilities ?? frame.params.capabilities ?? {};
    if (
      capabilityRequestsAuthority(capabilities?.fs) ||
      capabilityRequestsAuthority(capabilities?.fileSystem) ||
      capabilityRequestsAuthority(capabilities?.terminal)
    ) {
      throw new TypeError(
        `${label} must advertise no filesystem or terminal authority`,
      );
    }
}

function validateEnvironment(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("environment must be an object");
  }
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (
      !SAFE_ENVIRONMENT_NAME.test(name) ||
      !SAFE_ENVIRONMENT_NAMES.has(name)
    ) {
      throw new TypeError(`Environment name is not probe-allowlisted: ${name}`);
    }
    if (typeof item !== "string" || Buffer.byteLength(item) > 4096) {
      throw new TypeError(`Invalid environment value for ${name}`);
    }
    result[name] = item;
  }
  return result;
}

function capabilityRequestsAuthority(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(capabilityRequestsAuthority);
  if (typeof value === "object") {
    return Object.values(value).some(capabilityRequestsAuthority);
  }
  return true;
}

function validateStringArray(value, name, maxItems, maxBytes) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${name} must contain at most ${maxItems} strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || Buffer.byteLength(item) > maxBytes) {
      throw new TypeError(`${name}[${index}] must be a bounded string`);
    }
    return item;
  });
}

function validateLimits(value) {
  const result = { ...DEFAULT_LIMITS };
  for (const [name, item] of Object.entries(value)) {
    if (!(name in DEFAULT_LIMITS))
      throw new TypeError(`Unknown probe limit: ${name}`);
    if (!Number.isSafeInteger(item) || item < 1 || item > 64 * 1024 * 1024) {
      throw new TypeError(`Invalid probe limit: ${name}`);
    }
    result[name] = item;
  }
  if (result.maxFrameBytes > result.maxStdoutBytes) {
    throw new TypeError("maxFrameBytes cannot exceed maxStdoutBytes");
  }
  return Object.freeze(result);
}

function validateAbortSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

function combineAbortSignals(first, second) {
  if (first === undefined) return second;
  if (second === undefined || second === first) return first;
  return AbortSignal.any([first, second]);
}

async function executeSandbox(context) {
  const { limits } = context;
  const stdoutPath = path.join(context.rawRoot, "stdout.raw");
  const stderrPath = path.join(context.rawRoot, "stderr.raw");
  const [stdoutFile, stderrFile] = await Promise.all([
    open(stdoutPath, "wx", 0o600),
    open(stderrPath, "wx", 0o600),
  ]);
  const command = buildBubblewrapCommand(context);
  const executableHandle = context.fixtureRuntime
    ? undefined
    : await open(`/proc/self/fd/${context.retainedFileDescriptor}`, "r");
  let child;
  try {
    child = spawn(context.bubblewrap.path, command, {
      cwd: "/",
      detached: true,
      env: {},
      stdio:
        executableHandle === undefined
          ? ["pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe", executableHandle.fd],
    });
  } catch (error) {
    await executableHandle?.close();
    throw error;
  }
  const processGroupId = child.pid;
  if (processGroupId === undefined) throw new Error("bubblewrap_pid_missing");
  let violation;
  let timedOut = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdoutChunks = [];
  const stderrTailChunks = [];
  let stderrTailBytes = 0;
  let stdoutRawBytes = 0;
  let stderrRawBytes = 0;
  const rawWrites = [];

  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ code: null, signal: null, error }),
    );
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stdioCompletion = Promise.allSettled([
    finished(child.stdout),
    finished(child.stderr),
  ]);

  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stdoutBytes += bytes.length;
    stdoutHash.update(bytes);
    const remaining = Math.max(0, limits.maxStdoutBytes - stdoutRawBytes);
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      stdoutRawBytes += retained.length;
      rawWrites.push(stdoutFile.write(retained));
    }
    if (stdoutBytes <= limits.maxStdoutBytes) stdoutChunks.push(bytes);
    if (stdoutBytes > limits.maxStdoutBytes && violation === undefined) {
      violation = "stdout_limit_exceeded";
      killProcessGroup(processGroupId, "SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stderrBytes += bytes.length;
    stderrHash.update(bytes);
    const remaining = Math.max(0, limits.maxStderrBytes - stderrRawBytes);
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      stderrRawBytes += retained.length;
      rawWrites.push(stderrFile.write(retained));
    }
    stderrTailChunks.push(bytes);
    stderrTailBytes += bytes.length;
    while (
      stderrTailBytes > limits.maxStderrBytes &&
      stderrTailChunks.length > 0
    ) {
      const removed = stderrTailChunks.shift();
      stderrTailBytes -= removed.length;
    }
    if (stderrBytes > limits.maxStderrBytes && violation === undefined) {
      violation = "stderr_limit_exceeded";
      killProcessGroup(processGroupId, "SIGKILL");
    }
  });

  const hardDeadline = Date.now() + limits.timeoutMs;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    violation ??= "probe_timeout";
    killProcessGroup(processGroupId, "SIGKILL");
  }, limits.timeoutMs);
  hardTimer.unref?.();

  try {
    if (context.mode === GROK_PROBE_MODES.O1_NO_INITIALIZE) {
      await delay(limits.observationMs);
      child.stdin.end();
    } else {
      for (const frame of context.inputFrames) {
        const encoded = `${frame.serialized}\n`;
        if (!child.stdin.write(encoded)) await onceDrain(child.stdin);
      }
      child.stdin.end();
    }

    let exit = await raceWithDelay(exitPromise, limits.terminateGraceMs);
    if (exit === undefined) {
      killProcessGroup(processGroupId, "SIGTERM");
      exit = await raceWithDelay(exitPromise, limits.killGraceMs);
    }
    if (exit === undefined) {
      killProcessGroup(processGroupId, "SIGKILL");
      exit = await exitPromise;
    }
    let stdioResults = await raceWithDelay(
      stdioCompletion,
      Math.max(1, hardDeadline - Date.now()),
    );
    if (stdioResults === undefined) {
      violation ??= "stdio_drain_timeout";
      killProcessGroup(processGroupId, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      stdioResults = await stdioCompletion;
    }
    if (stdioResults.some((result) => result.status === "rejected"))
      violation ??= "stdio_stream_error";
    clearTimeout(hardTimer);
    await Promise.all(rawWrites);
    await Promise.all([stdoutFile.sync(), stderrFile.sync()]);
    await Promise.allSettled([stdoutFile.close(), stderrFile.close()]);

    const descendantsGone = await waitForProcessGroupExit(
      processGroupId,
      limits.killGraceMs,
    );
    if (!descendantsGone) violation ??= "descendant_cleanup_failed";
    if (exit.error !== undefined) violation ??= "sandbox_spawn_failed";
    if (exit.code !== null && exit.code !== 0)
      violation ??= "probe_process_failed";

    const rawStdout = Buffer.concat(stdoutChunks);
    const frames =
      context.outputFormat === "raw"
        ? { values: [] }
        : parseStdoutFrames(rawStdout, limits);
    if (frames.violation !== undefined) violation ??= frames.violation;
    if (context.mode === GROK_PROBE_MODES.O1_NO_INITIALIZE) {
      const initialized = frames.values.some(
        (frame) =>
          frame?.method === "initialize" || frame?.result?.protocolVersion,
      );
      if (initialized) violation ??= "o1_initialize_traffic_observed";
    }
    const after = await createManifest(context.sandboxRoot, limits);
    const sanitizedFrames = redactValue(frames.values, context.canaries);
    const sanitizedBefore = redactValue(context.before, context.canaries);
    const sanitizedAfter = redactValue(after, context.canaries);
    const stderrTail = redactText(
      Buffer.concat(stderrTailChunks).toString("utf8"),
      context.canaries,
    );
    const result = {
      mode: context.mode,
      sandbox: {
        bubblewrapVersion: context.bubblewrap.version,
        userNamespace: true,
        pidNamespace: true,
        networkNamespace: true,
        hostRootMounted: false,
        runtimeMountsReadOnly: true,
        hostHomesHidden: true,
        environmentNames: [
          "HOME",
          "GROK_HOME",
          "PATH",
          "TMPDIR",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
          "ALL_PROXY",
          "DO_NOT_TRACK",
          "DISABLE_TELEMETRY",
          "GROK_DISABLE_AUTOUPDATER",
          "GROK_PROMPT_SUGGESTIONS",
          "GROK_TELEMETRY_ENABLED",
          "GROK_TURN_SUMMARY",
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "NO_PROXY",
          "NO_COLOR",
          "OTEL_SDK_DISABLED",
          ...Object.keys(context.environment).sort(),
        ],
      },
      exit: {
        code: exit.code,
        signal: exit.signal,
        spawnedError: exit.error
          ? redactText(
              String(exit.error.message ?? exit.error),
              context.canaries,
            )
          : undefined,
        timedOut,
      },
      stdout: {
        bytes: stdoutBytes,
        sha256: stdoutHash.digest("hex"),
        frameCount: frames.values.length,
        frames: sanitizedFrames,
        ...(context.outputFormat === "raw"
          ? {
              sanitizedText: redactText(
                rawStdout.toString("utf8"),
                context.canaries,
              ),
            }
          : {}),
      },
      stderr: {
        bytes: stderrBytes,
        sha256: stderrHash.digest("hex"),
        redactedTail: boundedText(stderrTail, limits.maxStderrBytes),
        truncated: stderrBytes > limits.maxStderrBytes,
      },
      filesystem: {
        before: sanitizedBefore,
        after: sanitizedAfter,
        changes: redactValue(
          manifestChanges(context.before, after),
          context.canaries,
        ),
      },
      cleanup: {
        ...(context.exposeTemporaryIdentity
          ? {
              temporaryRoot: context.temporaryRoot,
              processGroupId,
            }
          : {}),
        processGroupTerminated: descendantsGone,
        temporaryRootRemovedOnReturn: true,
      },
      violation,
    };
    if (violation !== undefined) {
      throw new GrokProbeSandboxError(
        violation,
        `Grok probe stopped by safety boundary: ${violation}`,
        result,
      );
    }
    return result;
  } finally {
    clearTimeout(hardTimer);
    if (isProcessGroupAlive(processGroupId)) {
      killProcessGroup(processGroupId, "SIGKILL");
      await waitForProcessGroupExit(processGroupId, limits.killGraceMs);
    }
    await Promise.allSettled([
      executableHandle?.close(),
      stdoutFile.close(),
      stderrFile.close(),
    ]);
  }
}

function buildBubblewrapCommand(context) {
  const sandboxExecutable = "/mnt/probe/executable";
  const sandboxScript = "/mnt/probe/child.mjs";
  const environment = {
    HOME: "/home/probe",
    GROK_HOME: "/home/probe/.grok",
    PATH: context.fixtureRuntime ? "/usr/bin:/bin" : "",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/home/probe/.cache",
    XDG_CONFIG_HOME: "/home/probe/.config",
    XDG_DATA_HOME: "/home/probe/.local/share",
    XDG_STATE_HOME: "/home/probe/.local/state",
    DO_NOT_TRACK: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "socks5://127.0.0.1:9",
    NO_PROXY: "",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_TELEMETRY_ENABLED: "false",
    OTEL_SDK_DISABLED: "true",
    DISABLE_TELEMETRY: "1",
    GROK_PROMPT_SUGGESTIONS: "false",
    GROK_TURN_SUMMARY: "0",
    NO_COLOR: "1",
    ...context.environment,
  };
  const command = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--uid",
    "0",
    "--gid",
    "0",
    "--hostname",
    "grok-probe",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/etc",
    "--dir",
    "/etc/grok",
    "--dir",
    "/run",
    "--dir",
    "/tmp",
    "--dir",
    "/root",
    "--dir",
    "/home",
    "--dir",
    "/mnt",
    "--dir",
    "/mnt/probe",
    "--dir",
    "/mnt/workspace",
    "--dir",
    "/home/probe",
    ...(context.fixtureRuntime
      ? ["--ro-bind", context.executableMountSource, sandboxExecutable]
      : ["--ro-bind-fd", "3", sandboxExecutable]),
    "--bind",
    context.mounts.home,
    "/home/probe",
    "--bind",
    context.mounts.workspace,
    "/mnt/workspace",
    "--bind",
    context.mounts.tmp,
    "/tmp",
    "--ro-bind",
    context.mounts.etcGrok,
    "/etc/grok",
  ];
  if (context.fixtureRuntime) {
    command.push(
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
    );
  }
  if (context.scriptPath !== undefined) {
    command.push("--ro-bind", context.scriptPath, sandboxScript);
  }
  command.push("--remount-ro", "/");
  for (const [name, value] of Object.entries(environment)) {
    command.push("--setenv", name, value);
  }
  command.push(
    "--chdir",
    "/mnt/workspace",
    "--",
    sandboxExecutable,
    ...(context.scriptPath === undefined ? [] : [sandboxScript]),
    ...context.arguments,
    ...(context.scriptPath === undefined ? [] : [context.hostCanaryPath]),
  );
  return command;
}

function sandboxMounts(sandboxRoot) {
  return {
    home: path.join(sandboxRoot, "home"),
    grokHome: path.join(sandboxRoot, "home", ".grok"),
    cache: path.join(sandboxRoot, "home", ".cache"),
    config: path.join(sandboxRoot, "home", ".config"),
    data: path.join(sandboxRoot, "home", ".local", "share"),
    state: path.join(sandboxRoot, "home", ".local", "state"),
    workspace: path.join(sandboxRoot, "workspace"),
    tmp: path.join(sandboxRoot, "tmp"),
    etcGrok: path.join(sandboxRoot, "etc-grok"),
  };
}

async function createSandboxDirectories(mounts) {
  await Promise.all(
    Object.values(mounts).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
}

async function seedAmbientCanaries(mounts, canary) {
  await writeFile(
    path.join(mounts.grokHome, "config.toml"),
    [
      "[cli]",
      "auto_update = false",
      "use_leader = false",
      "",
      "[features]",
      "telemetry = false",
      "feedback = false",
      "remote_fetch = false",
      "web_fetch = false",
      "",
      "[telemetry]",
      "trace_upload = false",
      "mixpanel_enabled = false",
      "",
      "[ui]",
      "yolo = false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const locations = [
    path.join(mounts.etcGrok, ".sedes-grok-probe-canary"),
    path.join(mounts.home, ".claude", ".sedes-grok-probe-canary"),
    path.join(mounts.config, "grok", ".sedes-grok-probe-canary"),
    path.join(mounts.grokHome, ".sedes-grok-probe-canary"),
    path.join(mounts.workspace, ".claude", ".sedes-grok-probe-canary"),
    path.join(mounts.workspace, ".grok", ".sedes-grok-probe-canary"),
    path.join(mounts.workspace, ".grok", "hooks", ".sedes-grok-probe-canary"),
    path.join(
      mounts.workspace,
      ".grok",
      "plugins",
      ".sedes-grok-probe-canary",
    ),
    path.join(mounts.workspace, ".sedes-grok-probe-mcp-canary"),
  ];
  for (const location of locations) {
    await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
    await writeFile(location, `${canary}\n`, { mode: 0o600 });
  }
}

function parseStdoutFrames(buffer, limits) {
  if (buffer.length === 0) return { values: [] };
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > limits.maxFrames) {
    return { values: [], violation: "stdout_frame_count_exceeded" };
  }
  const values = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) > limits.maxFrameBytes) {
      return { values, violation: "stdout_frame_limit_exceeded" };
    }
    if (line.length === 0) {
      return { values, violation: "malformed_stdout_frame" };
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      return { values, violation: "malformed_stdout_frame" };
    }
  }
  return { values };
}

async function createManifest(root, limits, signal) {
  signal?.throwIfAborted();
  const entries = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory, depth) {
    signal?.throwIfAborted();
    if (depth > limits.maxManifestDepth) {
      throw new GrokProbeSandboxError(
        "filesystem_depth_exceeded",
        "Probe filesystem exceeded manifest depth",
      );
    }
    const children = await readdir(directory, { withFileTypes: true });
    signal?.throwIfAborted();
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      signal?.throwIfAborted();
      if (entries.length >= limits.maxFilesystemEntries) {
        throw new GrokProbeSandboxError(
          "filesystem_entry_limit_exceeded",
          "Probe filesystem exceeded entry limit",
        );
      }
      if (!SAFE_RELATIVE_TARGET.test(child.name)) {
        throw new GrokProbeSandboxError(
          "filesystem_path_rejected",
          "Probe filesystem produced an unsafe path",
        );
      }
      const relative = path.posix.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      const metadata = await lstat(absolute);
      signal?.throwIfAborted();
      if (metadata.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "symlink",
          mode: metadata.mode & 0o777,
        });
      } else if (metadata.isDirectory()) {
        entries.push({
          path: relative,
          type: "directory",
          mode: metadata.mode & 0o777,
        });
        await visit(absolute, relative, depth + 1);
      } else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (
          totalBytes > limits.maxFilesystemBytes ||
          metadata.size > limits.maxManifestFileBytes
        ) {
          throw new GrokProbeSandboxError(
            "filesystem_byte_limit_exceeded",
            "Probe filesystem exceeded byte limit",
          );
        }
        const bytes = await readFile(absolute, { signal });
        signal?.throwIfAborted();
        entries.push({
          path: relative,
          type: "file",
          mode: metadata.mode & 0o777,
          bytes: metadata.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        entries.push({
          path: relative,
          type: "other",
          mode: metadata.mode & 0o777,
        });
      }
    }
  }
  await visit(root, ".", 0);
  signal?.throwIfAborted();
  return { entries, totalBytes };
}

function manifestChanges(before, after) {
  const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const entry of after.entries) {
    const old = previous.get(entry.path);
    if (old === undefined) changes.push({ kind: "created", entry });
    else if (JSON.stringify(old) !== JSON.stringify(entry)) {
      changes.push({ kind: "changed", before: old, after: entry });
    }
    previous.delete(entry.path);
  }
  for (const entry of previous.values())
    changes.push({ kind: "removed", entry });
  return changes;
}

function redactValue(value, canaries) {
  if (typeof value === "string") return redactText(value, canaries);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, canaries));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, canaries),
      ]),
    );
  }
  return value;
}

function redactText(value, canaries) {
  let result = value;
  for (const canary of canaries) {
    if (canary.length > 0) result = result.split(canary).join("<redacted>");
  }
  return result;
}

function boundedText(value, maxBytes) {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

async function resolveRegularFile(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  const resolved = await realpath(value);
  const metadata = await stat(resolved);
  if (!metadata.isFile())
    throw new TypeError(`${field} must resolve to a file`);
  return resolved;
}

function killProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    await delay(20);
  }
  return !isProcessGroupAlive(processGroupId);
}

function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function raceWithDelay(promise, milliseconds) {
  return await Promise.race([
    promise,
    delay(milliseconds).then(() => undefined),
  ]);
}

async function runCommand(command, args, timeoutMs, deadlineSignal) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGKILL");
    deadlineSignal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      deadlineSignal?.removeEventListener("abort", abort);
      resolve({ code: null, signal: null, stdout: "", stderr: String(error) });
    });
    child.once("exit", (code, childSignal) => {
      clearTimeout(timer);
      deadlineSignal?.removeEventListener("abort", abort);
      resolve({
        code,
        signal: childSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
