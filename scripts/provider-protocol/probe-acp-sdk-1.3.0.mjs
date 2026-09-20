#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_VERSION = "1.3.0";
const EXPECTED_INTEGRITY =
  "sha512-i3h/efaeuMUFAO1HSfo97QZQnnvMd7wWBYtBsdL6UMZg3a78sk3Ffya5Xu7C7tYsXomXoDXJBAzQF2PcFKAhIQ==";
const EXPECTED_TARBALL_SHA256 =
  "0baf5b6be1842d00bf989c0211b7e44a15f88769d2fffd5036397ba249becc9f";
const EXPECTED_ZOD_VERSION = "4.4.3";
const EXPECTED_ZOD_LICENSE_SHA256 =
  "3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8";
const STRESS_COUNT = 64;

function buildCanonicalEvidence(raw) {
  return {
    evidenceVersion: 1,
    package: raw.package,
    licenseAudit: {
      sdkDisposition:
        "compatible-permissive; retain Apache-2.0 license in distributions",
      noticeFilePresent: raw.licenseAudit.noticeFilePresent,
      runtimeDependencies: raw.package.dependencies,
      optionalDependencies: raw.package.optionalDependencies,
      peerDependency: raw.peerDependency,
    },
    publicSurface: raw.publicSurface,
    behavior: raw.behavior,
    decision: {
      correlationOwner: "sedes",
      sharedCorrelatedCore: "rejected",
      adapterShape:
        "assured-transport-to-sedes-peer; public SDK object Stream only for official compatibility fixture",
      schemaCompiler:
        "Ajv2020 strict non-mutating named validators plus Sedes refinements",
      syntheticNonGrokProfile: "probe/* extension profile",
      reverseAuthorityRule:
        "deny known-but-unadvertised methods before authority resolution",
      deadlineRule:
        "close or quarantine the generation and preserve delivery phase",
      idRule:
        "safe finite integer or bounded string subset; reject duplicates and tombstone late responses",
      dependencyPin: "@agentclientprotocol/sdk@1.3.0",
      dependencyClass: "runtime-exact",
      subsystems: {
        stableV1Types: "adopted",
        stableV1Schema: "wrapped",
        methodAndProtocolConstants: "adopted",
        generatedRuntimeValidation: "wrapped",
        publicObjectStream: "wrapped",
        ndJsonStream: "rejected",
        connectionEngine: "rejected",
        activeSession: "rejected",
        extensionDispatcher: "rejected",
        requestError: "wrapped",
        experimentalV2: "rejected",
        experimentalHttpWebSocketAndServer: "rejected",
      },
    },
  };
}

function writeEvidence(evidence) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

const firstArgument = process.argv[2];
if (firstArgument === "--fixture") {
  const fixturePath = process.argv[3];
  if (!fixturePath) {
    throw new Error("--fixture requires a raw-facts JSON path");
  }
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  await writeEvidence(buildCanonicalEvidence(raw));
  process.exit();
}

const packageRoot = firstArgument;
const tarballPath = process.argv[3];
if (!packageRoot || !tarballPath) {
  console.error(
    "Usage: node scripts/provider-protocol/probe-acp-sdk-1.3.0.mjs /path/to/extracted/package /path/to/agentclientprotocol-sdk-1.3.0.tgz",
  );
  process.exitCode = 2;
  process.exit();
}

const packageJsonPath = path.join(packageRoot, "package.json");
const licensePath = path.join(packageRoot, "LICENSE");
const schemaPath = path.join(packageRoot, "schema", "schema.json");
const rootModulePath = path.join(packageRoot, "dist", "acp.js");
const connectionPath = path.join(packageRoot, "dist", "jsonrpc.js");
const connectionTypesPath = path.join(packageRoot, "dist", "jsonrpc.d.ts");
const zodRoot = path.join(packageRoot, "node_modules", "zod");
const zodPackageJsonPath = path.join(zodRoot, "package.json");
const zodLicensePath = path.join(zodRoot, "LICENSE");

const [
  packageJsonBytes,
  licenseBytes,
  schemaBytes,
  connectionSource,
  connectionTypesSource,
  tarballBytes,
  zodPackageJsonBytes,
  zodLicenseBytes,
  packageEntries,
] = await Promise.all([
  readFile(packageJsonPath),
  readFile(licensePath),
  readFile(schemaPath),
  readFile(connectionPath, "utf8"),
  readFile(connectionTypesPath, "utf8"),
  readFile(tarballPath),
  readFile(zodPackageJsonPath),
  readFile(zodLicensePath),
  readdir(packageRoot, { withFileTypes: true }),
]);
const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
const stableSchema = JSON.parse(schemaBytes.toString("utf8"));
const zodPackageJson = JSON.parse(zodPackageJsonBytes.toString("utf8"));

if (
  packageJson.name !== "@agentclientprotocol/sdk" ||
  packageJson.version !== EXPECTED_VERSION
) {
  throw new Error(
    `Expected @agentclientprotocol/sdk@${EXPECTED_VERSION}, received ${packageJson.name}@${packageJson.version}`,
  );
}

const tarballSha256 = sha256(tarballBytes);
if (tarballSha256 !== EXPECTED_TARBALL_SHA256) {
  throw new Error(
    `ACP SDK tarball SHA-256 mismatch: expected ${EXPECTED_TARBALL_SHA256}, received ${tarballSha256}`,
  );
}
if (
  zodPackageJson.name !== "zod" ||
  zodPackageJson.version !== EXPECTED_ZOD_VERSION ||
  zodPackageJson.license !== "MIT"
) {
  throw new Error(
    `Expected zod@${EXPECTED_ZOD_VERSION} (MIT), received ${zodPackageJson.name}@${zodPackageJson.version} (${zodPackageJson.license})`,
  );
}
const zodLicenseSha256 = sha256(zodLicenseBytes);
if (zodLicenseSha256 !== EXPECTED_ZOD_LICENSE_SHA256) {
  throw new Error(
    `Zod license SHA-256 mismatch: expected ${EXPECTED_ZOD_LICENSE_SHA256}, received ${zodLicenseSha256}`,
  );
}

const sendRequestOptions = extractExportedObjectType(
  connectionTypesSource,
  "SendRequestOptions",
);
const exposesRequestDeadlineOption =
  /(?:^|\n)\s*(?:deadline|timeout)\w*\??\s*:/i.test(sendRequestOptions);
const noticeFilePresent = packageEntries.some(
  (entry) => entry.isFile() && /^notice(?:\.|$)/i.test(entry.name),
);

const acp = await import(pathToFileURL(rootModulePath).href);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractExportedObjectType(source, typeName) {
  const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `export type ${escapedName} = \\{([\\s\\S]*?)\\n\\};`,
  ).exec(source);
  if (!match) {
    throw new Error(`Missing exported object type ${typeName}`);
  }
  return match[1];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function streamHarness(onWrite = async () => {}) {
  let controller;
  const writes = [];
  const readable = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const writable = new WritableStream({
    async write(message) {
      writes.push(message);
      await onWrite(message);
    },
  });
  return {
    stream: { readable, writable },
    writes,
    receive(message) {
      controller.enqueue(message);
    },
    end() {
      controller.close();
    },
  };
}

async function captureSettlement(promise) {
  const marker = Symbol("pending");
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    ),
    tick().then(() => marker),
  ]);
}

async function probeDeliveryClassification() {
  class DeliveryBoundaryError extends Error {
    constructor(disposition) {
      super(disposition);
      this.disposition = disposition;
    }
  }

  const deliveryError = new DeliveryBoundaryError("sent_outcome_unknown");
  const harness = streamHarness(async () => {
    throw deliveryError;
  });
  const connection = acp.client().connect(harness.stream);
  const result = await connection.agent.request("probe/delivery", {}).then(
    () => null,
    (error) => error,
  );
  await connection.closed;
  return {
    writeErrorIdentityPreserved: result === deliveryError,
    dispositionPreserved: result?.disposition === "sent_outcome_unknown",
    connectionClosedOnWriteFailure: connection.signal.aborted,
  };
}

async function probeResultValidation() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);
  const pending = connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  await waitFor(() => harness.writes.length === 1, "initialize request");
  const request = harness.writes[0];
  const invalidResult = { structurallyInvalid: "accepted" };
  harness.receive({ jsonrpc: "2.0", id: request.id, result: invalidResult });
  const result = await pending;
  connection.close();
  return {
    builtInInvalidResultAccepted: result === invalidResult,
    route: request.method,
  };
}

async function probeOutgoingConcurrency() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);
  const pending = Array.from({ length: STRESS_COUNT }, (_, index) =>
    connection.agent.request("probe/pending", { index }),
  );
  await waitFor(
    () => harness.writes.length === STRESS_COUNT,
    `${STRESS_COUNT} outgoing requests`,
  );
  connection.close(new Error("bounded probe close"));
  await Promise.allSettled(pending);
  return {
    attempted: STRESS_COUNT,
    acceptedWithoutEngineCapacityError: harness.writes.length,
  };
}

async function probeIncomingConcurrencyAndExtension() {
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  let parsedExtensionCalls = 0;
  const app = acp.client({ name: "sedes-acp-spike" }).onRequest(
    "probe/block",
    (params) => {
      if (
        typeof params !== "object" ||
        params === null ||
        typeof params.index !== "number"
      ) {
        throw new Error("invalid probe params");
      }
      parsedExtensionCalls += 1;
      return params;
    },
    async ({ params }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const release = deferred();
      releases.push(release);
      await release.promise;
      active -= 1;
      return { index: params.index };
    },
  );
  const harness = streamHarness();
  const connection = app.connect(harness.stream);
  for (let index = 0; index < STRESS_COUNT; index += 1) {
    harness.receive({
      jsonrpc: "2.0",
      id: index,
      method: "probe/block",
      params: { index },
    });
  }
  await waitFor(
    () => maximumActive === STRESS_COUNT,
    `${STRESS_COUNT} concurrent inbound handlers`,
  );
  for (const release of releases) release.resolve();
  await waitFor(
    () => harness.writes.length === STRESS_COUNT,
    `${STRESS_COUNT} extension responses`,
  );
  connection.close();
  return {
    attempted: STRESS_COUNT,
    maximumActive,
    parsedExtensionCalls,
    extensionRegistrationWorks: harness.writes.every(
      (message) => "result" in message && message.result.index === message.id,
    ),
  };
}

async function probePerSessionRouting() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);

  async function startSession(sessionId) {
    const pending = connection.agent.buildSession("/tmp/acp-spike").start();
    await waitFor(
      () =>
        harness.writes.some(
          (message) =>
            "method" in message &&
            message.method === acp.methods.agent.session.new &&
            !message.__answered,
        ),
      `session/new for ${sessionId}`,
    );
    const request = harness.writes.find(
      (message) =>
        "method" in message &&
        message.method === acp.methods.agent.session.new &&
        !message.__answered,
    );
    Object.defineProperty(request, "__answered", { value: true });
    harness.receive({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    return pending;
  }

  const first = await startSession("first");
  const second = await startSession("second");
  function update(sessionId, text) {
    harness.receive({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
  }
  update("second", "second-only");
  update("first", "first-only");
  const [firstUpdate, secondUpdate] = await Promise.all([
    first.nextUpdate(),
    second.nextUpdate(),
  ]);
  for (let index = 0; index < STRESS_COUNT; index += 1) {
    update("first", `queued-${index}`);
  }
  await tick();
  const queued = [];
  for (let index = 0; index < STRESS_COUNT; index += 1) {
    queued.push(await first.nextUpdate());
  }
  first.dispose();
  second.dispose();
  connection.close();
  return {
    crossSessionIsolation:
      firstUpdate.update.content.text === "first-only" &&
      secondUpdate.update.content.text === "second-only",
    queuedWithoutCapacityFailure: queued.length,
  };
}

async function probeCancellation() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);
  const abortController = new AbortController();
  const pending = connection.agent.request(
    "probe/cancel",
    {},
    { cancellationSignal: abortController.signal },
  );
  await waitFor(() => harness.writes.length === 1, "cancellable request");
  const request = harness.writes[0];
  abortController.abort();
  await waitFor(() => harness.writes.length === 2, "cancel notification");
  const cancel = harness.writes[1];
  const afterAbort = await captureSettlement(pending);
  harness.receive({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32800, message: "cancelled" },
  });
  await pending.catch(() => {});
  connection.close();
  return {
    protocolCancelMethod: cancel.method,
    cancelTargetsRequest: cancel.params?.requestId === request.id,
    requestRemainsPendingAfterAbort: typeof afterAbort === "symbol",
  };
}

async function probeReverseAuthority() {
  let acquiredAuthority = false;
  const app = acp
    .client()
    .onRequest(acp.methods.client.fs.readTextFile, async () => {
      acquiredAuthority = true;
      return { content: "probe" };
    });
  const harness = streamHarness();
  const connection = app.connect(harness.stream);
  harness.receive({
    jsonrpc: "2.0",
    id: 7,
    method: acp.methods.client.fs.readTextFile,
    params: { sessionId: "session", path: "/tmp/probe" },
  });
  await waitFor(() => harness.writes.length === 1, "filesystem response");
  connection.close();
  return {
    handlerRanWithoutInitialize: acquiredAuthority,
    engineEnforcesNegotiatedCapability: false,
    method: acp.methods.client.fs.readTextFile,
  };
}

async function probeCloseSettlement() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);
  const pending = connection.agent.request("probe/close", {});
  await waitFor(() => harness.writes.length === 1, "pending close request");
  const closeError = new Error("sanitized close");
  connection.close(closeError);
  const result = await pending.then(
    () => null,
    (error) => error,
  );
  return {
    closeRejectsPending: result === closeError,
    closeIsIdempotent: (() => {
      connection.close(new Error("ignored second close"));
      return connection.signal.reason === closeError;
    })(),
  };
}

async function probeDiagnostics() {
  const marker = "secret-marker-never-recorded";
  const captured = [];
  const original = console.error;
  console.error = (...values) => captured.push(values);
  try {
    const app = acp.client().onNotification(
      "probe/diagnostic",
      () => {
        throw new Error("sanitized parser failure");
      },
      () => {},
    );
    const harness = streamHarness();
    const connection = app.connect(harness.stream);
    harness.receive({
      jsonrpc: "2.0",
      method: "probe/diagnostic",
      params: { value: marker },
    });
    await waitFor(() => captured.length > 0, "SDK diagnostic");
    connection.close();
  } finally {
    console.error = original;
  }
  return {
    consoleErrorUsed: captured.length > 0,
    rawWireMarkerExposed: captured.some((entry) =>
      entry.some((value) => {
        try {
          return JSON.stringify(value).includes(marker);
        } catch {
          return false;
        }
      }),
    ),
  };
}

async function probeStableBatchRejection() {
  const harness = streamHarness();
  const connection = acp.client().connect(harness.stream);
  harness.receive([
    { jsonrpc: "2.0", method: "probe/one" },
    { jsonrpc: "2.0", method: "probe/two" },
  ]);
  await connection.closed;
  return {
    stableConnectionClosedOnBatch: connection.signal.aborted,
    closeReasonMentionsBatch: String(connection.signal.reason).includes(
      "batches",
    ),
  };
}

async function probeIdsAndDuplicates() {
  let fractionalIdHandled = false;
  const app = acp.client().onRequest(
    "probe/id",
    (params) => params,
    async () => {
      fractionalIdHandled = true;
      return {};
    },
  );
  const harness = streamHarness();
  const connection = app.connect(harness.stream);
  harness.receive({
    jsonrpc: "2.0",
    id: 1.5,
    method: "probe/id",
    params: {},
  });
  await waitFor(() => harness.writes.length === 1, "fractional ID response");

  const captured = [];
  const original = console.error;
  console.error = (...values) => captured.push(values);
  try {
    const pending = connection.agent.request("probe/duplicate-response", {});
    await waitFor(
      () => harness.writes.length === 2,
      "duplicate response request",
    );
    const request = harness.writes[1];
    harness.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { first: true },
    });
    await pending;
    harness.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { second: true },
    });
    await waitFor(() => captured.length > 0, "duplicate response diagnostic");
  } finally {
    console.error = original;
    connection.close();
  }
  return {
    fractionalRequestIdAccepted: fractionalIdHandled,
    duplicateResponseLoggedAsUnknown: captured.some(
      (entry) => entry[0] === "Got response to unknown request",
    ),
    duplicateResponseTombstoneExposed: false,
  };
}

const behavior = {
  deliveryClassification: await probeDeliveryClassification(),
  resultValidation: await probeResultValidation(),
  outgoingConcurrency: await probeOutgoingConcurrency(),
  incomingConcurrencyAndExtension: await probeIncomingConcurrencyAndExtension(),
  perSessionRouting: await probePerSessionRouting(),
  cancellation: await probeCancellation(),
  reverseAuthority: await probeReverseAuthority(),
  closeSettlement: await probeCloseSettlement(),
  diagnostics: await probeDiagnostics(),
  stableBatchRejection: await probeStableBatchRejection(),
  idsAndDuplicates: await probeIdsAndDuplicates(),
};

const rootExports = Object.keys(acp).sort();
const rawEvidence = {
  package: {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    registryIntegrity: EXPECTED_INTEGRITY,
    packageShasum: "eafd8f1e0d3eb0ac01b964a173a49f866fda6d73",
    tarballSha256,
    repository: packageJson.repository?.url,
    stableRoot: packageJson.exports?.["."],
    schemaExport: packageJson.exports?.["./schema/schema.json"],
    dependencies: packageJson.dependencies ?? {},
    optionalDependencies: packageJson.optionalDependencies ?? {},
    peerDependencies: packageJson.peerDependencies ?? {},
    stableSchemaDialect: stableSchema.$schema,
    packageJsonSha256: sha256(packageJsonBytes),
    licenseSha256: sha256(licenseBytes),
    stableSchemaSha256: sha256(schemaBytes),
  },
  peerDependency: {
    name: zodPackageJson.name,
    resolvedVersion: zodPackageJson.version,
    license: zodPackageJson.license,
    licenseSha256: zodLicenseSha256,
  },
  licenseAudit: {
    noticeFilePresent,
  },
  publicSurface: {
    rootExports,
    exportsLowLevelConnection: rootExports.includes("Connection"),
    exportsWireStream: rootExports.includes("WireStream"),
    exportsStableSchemaFile: Boolean(
      packageJson.exports?.["./schema/schema.json"],
    ),
    sourceHasUnboundedPendingMap:
      connectionSource.includes("pendingResponses = new Map()") &&
      !connectionSource.includes("maxPendingResponses"),
    sourceHasUnboundedIncomingMap:
      connectionSource.includes("incomingRequests = new Map()") &&
      !connectionSource.includes("maxIncomingRequests"),
    requestDeadlineOptionAuthority: "public SendRequestOptions declaration",
    exposesRequestDeadlineOption,
  },
  behavior,
};

await writeEvidence(buildCanonicalEvidence(rawEvidence));
