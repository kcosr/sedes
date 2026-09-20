import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import {
  clientNotifications,
  clientRequests,
  refinementDomains,
  serverNotifications,
  serverRequests,
} from "./provider-protocol/codex-adoption-inventory.mjs";

const RELEASE = "0.153.0";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseRoot = path.join(
  repositoryRoot,
  "protocol",
  "codex-app-server",
  RELEASE,
);
const profiles = [
  {
    name: "stable",
    experimentalApi: false,
    committedOfficialRoot: path.join(releaseRoot, "official", "stable"),
    committedRoot: path.join(releaseRoot, "generated"),
    committedManifest: path.join(releaseRoot, "protocol-manifest.json"),
  },
  {
    name: "experimental",
    experimentalApi: true,
    committedOfficialRoot: path.join(releaseRoot, "official", "experimental"),
    committedRoot: path.join(releaseRoot, "generated-experimental"),
    committedManifest: path.join(
      releaseRoot,
      "protocol-manifest-experimental.json",
    ),
  },
];
const releaseMetadata = JSON.parse(
  await readFile(path.join(releaseRoot, "release.json"), "utf8"),
);
const sourceProofRoot = path.join(
  repositoryRoot,
  "src",
  "server",
  "provider-protocol",
  "bindings",
  "codex-app-server",
  "generated",
  RELEASE,
);
const adoptionManifestPath = path.join(releaseRoot, "adoption-manifest.json");
const generationPlatform = releaseMetadata.generation.supportedPlatforms.find(
  (candidate) =>
    candidate.nodePlatform === process.platform &&
    candidate.nodeArch === process.arch,
);
if (generationPlatform === undefined) {
  throw new Error(
    `Codex protocol generation has no reviewed artifact for ${process.platform}/${process.arch}.`,
  );
}
const codexBinary = path.join(
  repositoryRoot,
  "node_modules",
  generationPlatform.nativePackage,
  ...generationPlatform.executableRelativePath.split("/"),
);
const checkOnly = process.argv.slice(2).includes("--check");

assertInstalledReleaseContract(releaseMetadata);

const versionOutput = execFileSync(codexBinary, ["--version"], {
  encoding: "utf8",
}).trim();
if (versionOutput !== `codex-cli ${RELEASE}`) {
  throw new Error(
    `Expected Codex ${RELEASE}, received ${JSON.stringify(versionOutput)}.`,
  );
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "sedes-codex-protocol-"),
);
try {
  const stagedProfiles = new Map();
  const generatedProfileManifests = new Map();
  for (const profile of profiles) {
    const rawTypes = path.join(temporaryRoot, `${profile.name}-raw-types`);
    const rawSchemas = path.join(temporaryRoot, `${profile.name}-raw-schemas`);
    const repeatedTypes = path.join(
      temporaryRoot,
      `${profile.name}-repeated-raw-types`,
    );
    const repeatedSchemas = path.join(
      temporaryRoot,
      `${profile.name}-repeated-raw-schemas`,
    );
    const official = path.join(temporaryRoot, `${profile.name}-official`);
    const firstCodexHome = path.join(
      temporaryRoot,
      `${profile.name}-first-codex-home`,
    );
    const repeatedCodexHome = path.join(
      temporaryRoot,
      `${profile.name}-repeated-codex-home`,
    );
    const staged = path.join(temporaryRoot, `${profile.name}-staged`);
    await Promise.all([
      mkdir(rawTypes, { recursive: true }),
      mkdir(rawSchemas, { recursive: true }),
      mkdir(repeatedTypes, { recursive: true }),
      mkdir(repeatedSchemas, { recursive: true }),
      mkdir(official, { recursive: true }),
      mkdir(firstCodexHome, { recursive: true }),
      mkdir(repeatedCodexHome, { recursive: true }),
      mkdir(path.join(staged, "json-schema"), { recursive: true }),
    ]);

    const experimentalArgs = profile.experimentalApi ? ["--experimental"] : [];
    generateRawProfile({
      experimentalArgs,
      rawTypes,
      rawSchemas,
      isolatedCodexHome: firstCodexHome,
    });
    generateRawProfile({
      experimentalArgs,
      rawTypes: repeatedTypes,
      rawSchemas: repeatedSchemas,
      isolatedCodexHome: repeatedCodexHome,
    });
    await Promise.all([
      assertTreesEqual(rawTypes, repeatedTypes),
      assertTreesEqual(rawSchemas, repeatedSchemas),
    ]);
    await Promise.all([
      cp(rawTypes, path.join(official, "typescript"), { recursive: true }),
      cp(rawSchemas, path.join(official, "json-schema"), { recursive: true }),
    ]);

    const rawJsonSchemaInventory = await buildPathInventory(rawSchemas);
    const expectedRawJsonSchemaInventory =
      releaseMetadata.generation.rawJsonSchemaInventories[profile.name];
    if (
      rawJsonSchemaInventory.count !== expectedRawJsonSchemaInventory.count ||
      rawJsonSchemaInventory.pathSetSha256 !==
        expectedRawJsonSchemaInventory.pathSetSha256
    ) {
      throw new Error(
        `Generated Codex ${profile.name} raw JSON schema inventory does not match the pinned release contract.\n` +
          `Expected: ${JSON.stringify(expectedRawJsonSchemaInventory)}\n` +
          `Actual: ${JSON.stringify(rawJsonSchemaInventory)}`,
      );
    }

    for (const filename of [
      "codex_app_server_protocol.schemas.json",
      "codex_app_server_protocol.v2.schemas.json",
    ]) {
      const decoded = JSON.parse(
        await readFile(path.join(rawSchemas, filename), "utf8"),
      );
      await writeFile(
        path.join(staged, "json-schema", filename),
        `${JSON.stringify(canonicalize(decoded), null, 2)}\n`,
        "utf8",
      );
    }
    const manifest = await buildManifest(staged, official, profile);
    const encodedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    stagedProfiles.set(profile.name, { rawTypes, staged });
    generatedProfileManifests.set(profile.name, manifest);

    if (checkOnly) {
      await assertTreesEqual(profile.committedOfficialRoot, official);
      await assertTreesEqual(profile.committedRoot, staged);
      const committed = await readFile(profile.committedManifest, "utf8");
      if (committed !== encodedManifest) {
        throw new Error(
          `Generated Codex ${profile.name} protocol manifest drifted.`,
        );
      }
    } else {
      await rm(profile.committedOfficialRoot, {
        recursive: true,
        force: true,
      });
      await mkdir(path.dirname(profile.committedOfficialRoot), {
        recursive: true,
      });
      await cp(official, profile.committedOfficialRoot, { recursive: true });
      await rm(profile.committedRoot, { recursive: true, force: true });
      await mkdir(path.dirname(profile.committedRoot), { recursive: true });
      await cp(staged, profile.committedRoot, { recursive: true });
      await writeFile(profile.committedManifest, encodedManifest, "utf8");
    }
  }

  const stagedSourceProof = path.join(temporaryRoot, "source-proof");
  await generateSourceProof(
    stagedProfiles,
    generatedProfileManifests,
    stagedSourceProof,
  );
  const adoptionManifest = await buildAdoptionManifest({
    stagedProfiles,
    generatedProfileManifests,
    stagedSourceProof,
  });
  const encodedAdoptionManifest = `${JSON.stringify(adoptionManifest, null, 2)}\n`;
  if (checkOnly) {
    await assertTreesEqual(sourceProofRoot, stagedSourceProof);
    if (
      (await readFile(adoptionManifestPath, "utf8")) !== encodedAdoptionManifest
    ) {
      throw new Error("Codex protocol adoption manifest drifted.");
    }
  } else {
    await rm(sourceProofRoot, { recursive: true, force: true });
    await mkdir(path.dirname(sourceProofRoot), { recursive: true });
    await cp(stagedSourceProof, sourceProofRoot, { recursive: true });
    await writeFile(adoptionManifestPath, encodedAdoptionManifest, "utf8");
  }
  console.log(
    checkOnly
      ? `Codex ${RELEASE} stable and experimental protocol artifacts are current.`
      : `Generated Codex ${RELEASE} stable and experimental protocol artifacts.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function buildAdoptionManifest({
  stagedProfiles,
  generatedProfileManifests,
  stagedSourceProof,
}) {
  const definitions = new Map();
  for (const profileName of ["stable", "experimental"]) {
    const profile = requireStagedProfile(stagedProfiles, profileName);
    for (const bundle of [
      "codex_app_server_protocol.schemas.json",
      "codex_app_server_protocol.v2.schemas.json",
    ]) {
      const schema = JSON.parse(
        await readFile(
          path.join(profile.staged, "json-schema", bundle),
          "utf8",
        ),
      );
      for (const name of Object.keys(schema.definitions ?? {})) {
        const shortName = name.split("/").at(-1);
        const key = `${profileName}:${shortName}`;
        const locations = definitions.get(key) ?? [];
        locations.push({ bundle, pointer: `#/definitions/${name}` });
        definitions.set(key, locations);
      }
    }
  }

  const locate = (profile, definition, bundleKind) => {
    if (definition === null) return null;
    const locations = definitions.get(`${profile}:${definition}`) ?? [];
    const expectedBundle =
      bundleKind === "legacy"
        ? "codex_app_server_protocol.schemas.json"
        : "codex_app_server_protocol.v2.schemas.json";
    const selected = locations.filter(
      (location) => location.bundle === expectedBundle,
    );
    if (selected.length !== 1) {
      throw new Error(
        `Expected one ${profile} Codex definition named ${definition} in ${expectedBundle}, found ${selected.length}.`,
      );
    }
    return selected[0];
  };
  const ensureMethod = (profile, group, method) => {
    const manifest = generatedProfileManifests.get(profile);
    if (!manifest?.methods[group]?.includes(method)) {
      throw new Error(
        `Codex ${profile} ${group} does not contain adopted method ${method}.`,
      );
    }
  };
  const routes = [];
  for (const [
    method,
    params,
    result,
    domain,
    stability = "stable",
    artifactProfile = stability,
    use = "invoked",
  ] of clientRequests) {
    const profile = artifactProfile;
    ensureMethod(profile, "clientRequests", method);
    routes.push({
      direction: "client_request",
      method,
      use,
      stability,
      artifactProfile: profile,
      domain,
      paramsDefinition: params,
      paramsSchema: locate(
        profile,
        params,
        method === "initialize" ? "legacy" : "v2",
      ),
      resultDefinition: result,
      resultSchema: locate(
        profile,
        result,
        method === "initialize" ? "legacy" : "v2",
      ),
      sedesRefinements: refinementDomains[domain],
    });
  }
  for (const [method, params, domain] of clientNotifications) {
    ensureMethod("stable", "clientNotifications", method);
    routes.push({
      direction: "client_notification",
      method,
      use: "emitted",
      stability: "stable",
      artifactProfile: "stable",
      domain,
      envelopeDefinition: "ClientNotification",
      paramsDefinition: params,
      sedesRefinements: refinementDomains[domain],
    });
  }
  for (const [
    method,
    params,
    result,
    disposition,
    artifactProfile = "stable",
  ] of serverRequests) {
    ensureMethod(artifactProfile, "serverRequests", method);
    routes.push({
      direction: "server_request",
      method,
      use: disposition,
      stability: "stable",
      artifactProfile,
      domain: "interactions",
      paramsDefinition: params,
      paramsSchema: locate(artifactProfile, params, "legacy"),
      resultDefinition: result,
      resultSchema: locate(artifactProfile, result, "legacy"),
      sedesRefinements: refinementDomains.interactions,
    });
  }
  for (const [
    method,
    params,
    domain = "live_turns",
    use = "decoded",
    refinements = refinementDomains[domain],
    artifactProfile = "stable",
  ] of serverNotifications) {
    ensureMethod(artifactProfile, "serverNotifications", method);
    routes.push({
      direction: "server_notification",
      method,
      use,
      stability: "stable",
      artifactProfile,
      domain,
      paramsDefinition: params,
      paramsSchema: locate(artifactProfile, params, "v2"),
      sedesRefinements: refinements,
    });
  }
  const sourceProof = await buildArtifactInventory(stagedSourceProof);
  return {
    schemaVersion: 1,
    productionRelease: RELEASE,
    status: "production_parser_authority",
    productionRuntimeCompatibility: {
      currentPolicy: `stable releases at or above ${RELEASE} using exactly the ${RELEASE} parser profile`,
      disposition: "selected_exact_generated_profile",
      selectedD3InitialProfile: `exactly ${RELEASE}`,
      d3Requirement:
        "add a later release only through a finite generated-and-conformance-tested allowlist",
    },
    generatedProfiles: Object.fromEntries(
      [...generatedProfileManifests].map(([name, manifest]) => [
        name,
        {
          officialTreeSha256: manifest.officialTreeSha256,
          canonicalTreeSha256: manifest.treeSha256,
        },
      ]),
    ),
    sourceTransformation: {
      description:
        "copy adopted transitive TypeScript closures and append .js to relative NodeNext specifiers",
      treeSha256: sourceProof.treeSha256,
      artifacts: sourceProof.artifacts,
    },
    parserPolicy:
      "one selected structural profile per route; no stable/experimental fallback",
    errorSurfaces: [
      {
        kind: "error_notification",
        method: "error",
        officialDefinition: "ErrorNotification",
        disposition: "adopted_stable",
      },
      {
        kind: "rpc_error_response",
        officialDefinition: null,
        disposition: "missing_from_generated_route_result_mapping",
        sedesAuthority: "src/server/backends/codex/rpc/codex-rpc-client.ts",
      },
    ],
    cutoverOrder: [
      "initialization",
      "thread_history",
      "live_turns",
      "interactions",
      "actions",
    ],
    routes,
  };
}

function generateRawProfile({
  experimentalArgs,
  rawTypes,
  rawSchemas,
  isolatedCodexHome,
}) {
  const options = {
    stdio: "inherit",
    env: { ...process.env, CODEX_HOME: isolatedCodexHome },
  };
  execFileSync(
    codexBinary,
    ["app-server", "generate-ts", ...experimentalArgs, "--out", rawTypes],
    options,
  );
  execFileSync(
    codexBinary,
    [
      "app-server",
      "generate-json-schema",
      ...experimentalArgs,
      "--out",
      rawSchemas,
    ],
    options,
  );
}

async function generateSourceProof(
  stagedProfiles,
  generatedProfileManifests,
  outputRoot,
) {
  const stable = requireStagedProfile(stagedProfiles, "stable");
  const experimental = requireStagedProfile(stagedProfiles, "experimental");
  const officialStableServerNotifications =
    await readOfficialServerNotificationEntries(stable.rawTypes);
  const entries = await resolveAdoptedTypeEntries({
    stable,
    experimental,
    officialStableServerNotifications,
  });
  await Promise.all([
    copyTypeClosure({
      sourceRoot: stable.rawTypes,
      outputRoot: path.join(outputRoot, "stable"),
      entries: entries.stable,
    }),
    copyTypeClosure({
      sourceRoot: experimental.rawTypes,
      outputRoot: path.join(outputRoot, "experimental"),
      entries: entries.experimental,
    }),
    generateStandaloneValidators({
      stable,
      experimental,
      outputRoot,
      officialStableServerNotifications,
    }),
  ]);
  await generateRouteRegistry({
    entries,
    generatedProfileManifests,
    outputRoot,
    officialStableServerNotifications,
  });
  await assertGeneratedSourceImports(outputRoot);
}

async function resolveAdoptedTypeEntries({
  stable,
  experimental,
  officialStableServerNotifications,
}) {
  const stableDefinitions = new Set([
    "ClientNotification",
    "ServerNotification",
  ]);
  const experimentalDefinitions = new Set();
  for (const { params } of officialStableServerNotifications) {
    stableDefinitions.add(params);
  }
  for (const [
    _method,
    params,
    result,
    _domain,
    stability = "stable",
    artifactProfile = stability,
  ] of clientRequests) {
    const target =
      artifactProfile === "experimental"
        ? experimentalDefinitions
        : stableDefinitions;
    target.add(params);
    target.add(result);
  }
  for (const [
    _method,
    params,
    result,
    _use,
    artifactProfile = "stable",
  ] of serverRequests) {
    const target =
      artifactProfile === "experimental"
        ? experimentalDefinitions
        : stableDefinitions;
    target.add(params);
    target.add(result);
  }
  for (const [
    _method,
    params,
    _domain,
    _use,
    _refinements,
    artifactProfile = "stable",
  ] of serverNotifications) {
    (artifactProfile === "experimental"
      ? experimentalDefinitions
      : stableDefinitions
    ).add(params);
  }
  const resolveAll = async (sourceRoot, definitions) =>
    await Promise.all(
      [...definitions].sort(compareStrings).map(async (definition) => ({
        definition,
        relativePath: await resolveUniqueTypeEntry(sourceRoot, definition),
      })),
    );
  return {
    stable: await resolveAll(stable.rawTypes, stableDefinitions),
    experimental: await resolveAll(
      experimental.rawTypes,
      experimentalDefinitions,
    ),
  };
}

async function readOfficialServerNotificationEntries(sourceRoot) {
  const entry = await resolveUniqueTypeEntry(sourceRoot, "ServerNotification");
  const source = await readFile(path.join(sourceRoot, entry), "utf8");
  const entries = [
    ...source.matchAll(
      /\{ "method": "([^"]+)", "params": ([A-Za-z0-9_]+) \}/gu,
    ),
  ].map((match) => ({ method: match[1], params: match[2] }));
  const methods = new Set(entries.map(({ method }) => method));
  if (entries.length === 0 || methods.size !== entries.length) {
    throw new Error(
      "Stable ServerNotification TypeScript union did not yield one unique params type per method.",
    );
  }
  return entries.sort((left, right) =>
    compareStrings(left.method, right.method),
  );
}

async function resolveUniqueTypeEntry(sourceRoot, definition) {
  const filename = `${definition}.ts`;
  const matches = (await listFiles(sourceRoot)).filter(
    (relativePath) => path.basename(relativePath) === filename,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one generated Codex type named ${definition}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function requireStagedProfile(stagedProfiles, name) {
  const profile = stagedProfiles.get(name);
  if (!profile) throw new Error(`Missing staged Codex profile: ${name}`);
  return profile;
}

async function copyTypeClosure({ sourceRoot, outputRoot, entries }) {
  const pending = entries.map((entry) =>
    typeof entry === "string" ? entry : entry.relativePath,
  );
  const copied = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (copied.has(relative)) continue;
    copied.add(relative);
    const source = await readFile(path.join(sourceRoot, relative), "utf8");
    const rewritten = source.replace(
      /from "((?:\.\.?\/)[^"]+)"/g,
      (_match, specifier) => `from "${specifier}.js"`,
    );
    const destination = path.join(outputRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rewritten, "utf8");
    for (const match of source.matchAll(/from "((?:\.\.?\/)[^"]+)"/g)) {
      const dependency = path
        .relative(
          sourceRoot,
          path.resolve(sourceRoot, path.dirname(relative), `${match[1]}.ts`),
        )
        .split(path.sep)
        .join("/");
      if (dependency.startsWith("../")) {
        throw new Error(
          `Generated type import escapes source root: ${relative}`,
        );
      }
      pending.push(dependency);
    }
  }
}

async function generateStandaloneValidators({
  stable,
  experimental,
  outputRoot,
  officialStableServerNotifications,
}) {
  const stableLegacySchema = JSON.parse(
    await readFile(
      path.join(
        stable.staged,
        "json-schema",
        "codex_app_server_protocol.schemas.json",
      ),
      "utf8",
    ),
  );
  const stableV2Schema = JSON.parse(
    await readFile(
      path.join(
        stable.staged,
        "json-schema",
        "codex_app_server_protocol.v2.schemas.json",
      ),
      "utf8",
    ),
  );
  const experimentalV2Schema = JSON.parse(
    await readFile(
      path.join(
        experimental.staged,
        "json-schema",
        "codex_app_server_protocol.v2.schemas.json",
      ),
      "utf8",
    ),
  );
  const experimentalLegacySchema = JSON.parse(
    await readFile(
      path.join(
        experimental.staged,
        "json-schema",
        "codex_app_server_protocol.schemas.json",
      ),
      "utf8",
    ),
  );
  normalizeServerNotificationObjectType(stableLegacySchema, "stable legacy");
  normalizeServerNotificationObjectType(stableV2Schema, "stable v2");
  normalizeServerNotificationObjectType(
    experimentalLegacySchema,
    "experimental legacy",
  );
  normalizeServerNotificationObjectType(
    experimentalV2Schema,
    "experimental v2",
  );
  stableLegacySchema.$id = `urn:sedes:codex:${RELEASE}:stable:legacy`;
  stableV2Schema.$id = `urn:sedes:codex:${RELEASE}:stable:v2`;
  experimentalLegacySchema.$id = `urn:sedes:codex:${RELEASE}:experimental:legacy`;
  experimentalV2Schema.$id = `urn:sedes:codex:${RELEASE}:experimental:v2`;
  const ajv = new Ajv({
    strict: true,
    allErrors: false,
    validateFormats: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    code: { source: true, esm: true, optimize: true },
  });
  ajv.addSchema(stableLegacySchema);
  ajv.addSchema(stableV2Schema);
  ajv.addSchema(experimentalLegacySchema);
  ajv.addSchema(experimentalV2Schema);
  const validators = buildAdoptedValidatorReferences({
    stableLegacySchema,
    stableV2Schema,
    experimentalLegacySchema,
    experimentalV2Schema,
    officialStableServerNotifications,
  });
  for (const reference of Object.values(validators)) {
    if (!ajv.getSchema(reference)) {
      throw new Error(`Missing adopted Codex schema definition: ${reference}`);
    }
  }
  let source = standaloneCode(ajv, validators);
  let runtimeImports = "";
  source = source.replace(
    /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
    (_match, binding) => {
      runtimeImports =
        'import ucs2lengthRuntime from "ajv/dist/runtime/ucs2length.js";\n';
      return `const ${binding} = typeof ucs2lengthRuntime === "function" ? ucs2lengthRuntime : ucs2lengthRuntime.default;`;
    },
  );
  if (source.includes("require(")) {
    throw new Error(
      "Ajv standalone output contains an unreviewed CommonJS runtime helper.",
    );
  }
  const destination = path.join(outputRoot, "validators.ts");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    `// GENERATED CODE! DO NOT MODIFY BY HAND!\n// @ts-nocheck -- Ajv standalone output is JavaScript generated into TypeScript's source root.\n${runtimeImports}${source}\n`,
    "utf8",
  );
}

function normalizeServerNotificationObjectType(schema, profile) {
  const missingObjectTypePointers = [];
  const inspect = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.properties && value.type === undefined) {
      missingObjectTypePointers.push(pointer);
    }
    for (const [key, entry] of Object.entries(value)) {
      inspect(entry, `${pointer}/${key}`);
    }
  };
  inspect(schema, "");
  if (
    missingObjectTypePointers.length !== 1 ||
    missingObjectTypePointers[0] !== "/definitions/ServerNotification"
  ) {
    throw new Error(
      `${profile} Codex schema missing-object-type set changed: ${JSON.stringify(missingObjectTypePointers)}`,
    );
  }
  const serverNotification = schema.definitions?.ServerNotification;
  if (
    !serverNotification ||
    typeof serverNotification !== "object" ||
    Array.isArray(serverNotification) ||
    !serverNotification.properties ||
    !Array.isArray(serverNotification.oneOf)
  ) {
    throw new Error(
      `${profile} Codex ServerNotification normalization target changed shape.`,
    );
  }
  serverNotification.type = "object";
}

function buildAdoptedValidatorReferences({
  stableLegacySchema,
  stableV2Schema,
  experimentalLegacySchema,
  experimentalV2Schema,
  officialStableServerNotifications,
}) {
  const validators = {};
  const register = (profile, definition, schema) => {
    const name = validatorExportName(profile, definition);
    const reference = `${schema.$id}#/definitions/${definition}`;
    const existing = validators[name];
    if (existing !== undefined && existing !== reference) {
      throw new Error(`Conflicting Codex validator export: ${name}`);
    }
    validators[name] = reference;
  };
  for (const [
    method,
    params,
    result,
    _domain,
    stability = "stable",
    artifactProfile = stability,
  ] of clientRequests) {
    const schema =
      artifactProfile === "experimental"
        ? experimentalV2Schema
        : method === "initialize"
          ? stableLegacySchema
          : stableV2Schema;
    register(artifactProfile, params, schema);
    register(artifactProfile, result, schema);
  }
  register("stable", "ClientNotification", stableLegacySchema);
  for (const { params } of officialStableServerNotifications) {
    register("stable", params, stableV2Schema);
  }
  for (const [
    _method,
    params,
    result,
    _use,
    artifactProfile = "stable",
  ] of serverRequests) {
    const schema =
      artifactProfile === "experimental"
        ? experimentalLegacySchema
        : stableLegacySchema;
    register(artifactProfile, params, schema);
    register(artifactProfile, result, schema);
  }
  for (const [
    _method,
    params,
    _domain,
    _use,
    _refinements,
    artifactProfile = "stable",
  ] of serverNotifications) {
    register(
      artifactProfile,
      params,
      artifactProfile === "experimental"
        ? experimentalV2Schema
        : stableV2Schema,
    );
  }
  return Object.fromEntries(
    Object.entries(validators).sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );
}

function validatorExportName(profile, definition) {
  const prefix = profile === "experimental" ? "Experimental" : "Stable";
  return `validate${prefix}${definition}`;
}

async function generateRouteRegistry({
  entries,
  generatedProfileManifests,
  outputRoot,
  officialStableServerNotifications,
}) {
  const stablePaths = new Map(
    entries.stable.map(({ definition, relativePath }) => [
      definition,
      relativePath,
    ]),
  );
  const experimentalPaths = new Map(
    entries.experimental.map(({ definition, relativePath }) => [
      definition,
      relativePath,
    ]),
  );
  const importedTypes = new Map();
  const typeName = (profile, definition) => {
    const key = `${profile}:${definition}`;
    const existing = importedTypes.get(key);
    if (existing) return existing.alias;
    const source =
      profile === "experimental"
        ? experimentalPaths.get(definition)
        : stablePaths.get(definition);
    if (!source) {
      throw new Error(`Missing copied Codex type ${key}.`);
    }
    const alias = `${profile === "experimental" ? "Experimental" : "Stable"}${definition}`;
    importedTypes.set(key, { alias, profile, source, definition });
    return alias;
  };

  const clientRequestEntries = clientRequests.map(
    ([
      method,
      params,
      result,
      _domain,
      stability = "stable",
      artifactProfile = stability,
    ]) => ({
      method,
      stability,
      artifactProfile,
      params,
      result,
      paramsType: typeName(artifactProfile, params),
      resultType: typeName(artifactProfile, result),
    }),
  );
  const serverRequestEntries = serverRequests.map(
    ([method, params, result, use, artifactProfile = "stable"]) => ({
      method,
      params,
      result,
      use,
      artifactProfile,
      paramsType: typeName(artifactProfile, params),
      resultType: typeName(artifactProfile, result),
    }),
  );
  const serverNotificationEntries = serverNotifications.map(
    ([
      method,
      params,
      domain = "live_turns",
      use = "decoded",
      _refinements,
      artifactProfile = "stable",
    ]) => ({
      method,
      params,
      domain,
      use,
      artifactProfile,
      paramsType: typeName(artifactProfile, params),
    }),
  );
  const clientNotificationType = typeName("stable", "ClientNotification");
  const serverNotificationType = typeName("stable", "ServerNotification");
  const officialServerNotificationMethods =
    generatedProfileManifests.get("stable")?.methods.serverNotifications;
  if (!officialServerNotificationMethods) {
    throw new Error("Missing stable Codex server-notification inventory.");
  }
  if (
    JSON.stringify(officialServerNotificationMethods) !==
    JSON.stringify(
      officialStableServerNotifications.map(({ method }) => method),
    )
  ) {
    throw new Error(
      "Stable Codex ServerNotification TypeScript union and generated manifest differ.",
    );
  }

  const imports = [...importedTypes.values()]
    .sort((left, right) => compareStrings(left.alias, right.alias))
    .map(({ alias, profile, source, definition }) => {
      const relative = `./${profile}/${source.replace(/\.ts$/u, ".js")}`;
      return `import type { ${definition} as ${alias} } from ${JSON.stringify(relative)};`;
    });
  const validatorNames = new Set([
    validatorExportName("stable", "ClientNotification"),
  ]);
  for (const { params } of officialStableServerNotifications) {
    validatorNames.add(validatorExportName("stable", params));
  }
  for (const entry of clientRequestEntries) {
    validatorNames.add(
      validatorExportName(entry.artifactProfile, entry.params),
    );
    validatorNames.add(
      validatorExportName(entry.artifactProfile, entry.result),
    );
  }
  for (const entry of serverRequestEntries) {
    validatorNames.add(
      validatorExportName(entry.artifactProfile, entry.params),
    );
    validatorNames.add(
      validatorExportName(entry.artifactProfile, entry.result),
    );
  }
  for (const entry of serverNotificationEntries) {
    validatorNames.add(
      validatorExportName(entry.artifactProfile, entry.params),
    );
  }

  const interfaceEntries = (items, render) =>
    items
      .map(
        (entry) =>
          `  readonly ${JSON.stringify(entry.method)}: ${render(entry)};`,
      )
      .join("\n");
  const registryEntries = (items, render) =>
    items
      .map((entry) => `  ${JSON.stringify(entry.method)}: ${render(entry)},`)
      .join("\n");
  const source = `// GENERATED CODE! DO NOT MODIFY BY HAND!\n${imports.join("\n")}\nimport {\n${[
    ...validatorNames,
  ]
    .sort(compareStrings)
    .map((name) => `  ${name},`)
    .join(
      "\n",
    )}\n} from "./validators.js";\n\nexport const CODEX_APP_SERVER_RELEASE = ${JSON.stringify(RELEASE)} as const;\n\nexport interface CodexClientRequestMap {\n${interfaceEntries(clientRequestEntries, (entry) => `{ readonly params: ${entry.paramsType}; readonly result: ${entry.resultType}; readonly stability: ${JSON.stringify(entry.stability)} }`)}\n}\n\nexport interface CodexServerRequestMap {\n${interfaceEntries(serverRequestEntries, (entry) => `{ readonly params: ${entry.paramsType}; readonly result: ${entry.resultType}; readonly use: ${JSON.stringify(entry.use)} }`)}\n}\n\nexport interface CodexServerNotificationMap {\n${interfaceEntries(serverNotificationEntries, (entry) => `{ readonly params: ${entry.paramsType}; readonly domain: ${JSON.stringify(entry.domain)}; readonly use: ${JSON.stringify(entry.use)} }`)}\n}\n\nexport interface CodexClientNotificationMap {\n  readonly initialized: { readonly envelope: ${clientNotificationType} };\n}\n\nexport type CodexClientRequestMethod = keyof CodexClientRequestMap;\nexport type CodexServerRequestMethod = keyof CodexServerRequestMap;\nexport type CodexAdoptedServerNotificationMethod = keyof CodexServerNotificationMap;\nexport type CodexServerNotificationMethod = ${serverNotificationType}["method"];\nexport type CodexClientNotificationMethod = keyof CodexClientNotificationMap;\n\ntype RuntimeValidator = ((value: unknown) => boolean) & { readonly errors?: unknown };\ntype RequestRegistryEntry = { readonly params: RuntimeValidator; readonly result: RuntimeValidator; readonly stability?: "stable" | "experimental"; readonly use?: string };\ntype NotificationRegistryEntry = { readonly params: RuntimeValidator; readonly domain: string; readonly use: string };\ntype OfficialNotificationRegistryEntry = { readonly params: RuntimeValidator };\n\nexport const codexOfficialServerNotificationMethods = Object.freeze(${JSON.stringify(officialServerNotificationMethods)} as CodexServerNotificationMethod[]);\nexport const codexOfficialServerNotificationRegistry = Object.freeze({\n${registryEntries(officialStableServerNotifications, (entry) => `Object.freeze({ params: ${validatorExportName("stable", entry.params)} })`)}\n} satisfies Readonly<Record<CodexServerNotificationMethod, OfficialNotificationRegistryEntry>>);\n\nexport const codexClientRequestRegistry = Object.freeze({\n${registryEntries(clientRequestEntries, (entry) => `Object.freeze({ params: ${validatorExportName(entry.artifactProfile, entry.params)}, result: ${validatorExportName(entry.artifactProfile, entry.result)}, stability: ${JSON.stringify(entry.stability)} })`)}\n} satisfies Readonly<Record<CodexClientRequestMethod, RequestRegistryEntry>>);\n\nexport const codexServerRequestRegistry = Object.freeze({\n${registryEntries(serverRequestEntries, (entry) => `Object.freeze({ params: ${validatorExportName(entry.artifactProfile, entry.params)}, result: ${validatorExportName(entry.artifactProfile, entry.result)}, use: ${JSON.stringify(entry.use)} })`)}\n} satisfies Readonly<Record<CodexServerRequestMethod, RequestRegistryEntry>>);\n\nexport const codexServerNotificationRegistry = Object.freeze({\n${registryEntries(serverNotificationEntries, (entry) => `Object.freeze({ params: ${validatorExportName(entry.artifactProfile, entry.params)}, domain: ${JSON.stringify(entry.domain)}, use: ${JSON.stringify(entry.use)} })`)}\n} satisfies Readonly<Record<CodexAdoptedServerNotificationMethod, NotificationRegistryEntry>>);\n\nexport const codexClientNotificationRegistry = Object.freeze({\n  initialized: ${validatorExportName("stable", "ClientNotification")},\n} satisfies Readonly<Record<CodexClientNotificationMethod, RuntimeValidator>>);\n`;
  await writeFile(path.join(outputRoot, "route-registry.ts"), source, "utf8");
}

async function assertGeneratedSourceImports(outputRoot) {
  for (const relativePath of await listFiles(outputRoot)) {
    if (!relativePath.endsWith(".ts")) continue;
    const source = await readFile(path.join(outputRoot, relativePath), "utf8");
    for (const match of source.matchAll(/from ["']((?:\.\.?\/)[^"']+)["']/g)) {
      if (!match[1].endsWith(".js")) {
        throw new Error(
          `Generated Codex source contains an extensionless relative import: ${relativePath}: ${match[1]}`,
        );
      }
    }
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

async function buildManifest(generatedRoot, officialRoot, profile) {
  const files = await listFiles(generatedRoot);
  const artifacts = await Promise.all(
    files.map(async (filename) => {
      const contents = await readFile(path.join(generatedRoot, filename));
      return {
        path: filename.split(path.sep).join("/"),
        bytes: contents.byteLength,
        sha256: sha256(contents),
      };
    }),
  );
  const treeHash = createHash("sha256");
  for (const artifact of artifacts) {
    treeHash.update(artifact.path);
    treeHash.update("\0");
    treeHash.update(artifact.sha256);
    treeHash.update("\0");
  }
  const official = await buildArtifactInventory(officialRoot);
  const methodFiles = {
    clientRequests: "typescript/ClientRequest.ts",
    serverRequests: "typescript/ServerRequest.ts",
    serverNotifications: "typescript/ServerNotification.ts",
    clientNotifications: "typescript/ClientNotification.ts",
  };
  const methods = Object.fromEntries(
    await Promise.all(
      Object.entries(methodFiles).map(async ([group, filename]) => {
        const source = await readFile(
          path.join(officialRoot, filename),
          "utf8",
        );
        return [
          group,
          [
            ...new Set(
              [...source.matchAll(/"method": "([^"]+)"/g)].map(
                (match) => match[1],
              ),
            ),
          ].sort(compareStrings),
        ];
      }),
    ),
  );
  return {
    schemaVersion: 1,
    release: RELEASE,
    profile: profile.name,
    experimentalApi: profile.experimentalApi,
    generatorCommands: [
      `codex app-server generate-ts${profile.experimentalApi ? " --experimental" : ""} --out <temporary-directory>`,
      `codex app-server generate-json-schema${profile.experimentalApi ? " --experimental" : ""} --out <temporary-directory>`,
    ],
    canonicalization: "recursive-json-object-key-sort",
    officialGenerationEnvironment:
      "fresh empty temporary CODEX_HOME for each generation pass",
    duplicateCleanGenerationVerified: true,
    officialTreeSha256: official.treeSha256,
    officialArtifacts: official.artifacts,
    treeSha256: treeHash.digest("hex"),
    methods,
    artifacts,
  };
}

async function buildArtifactInventory(root) {
  const files = await listFiles(root);
  const artifacts = await Promise.all(
    files.map(async (filename) => {
      const contents = await readFile(path.join(root, filename));
      return {
        path: filename.split(path.sep).join("/"),
        bytes: contents.byteLength,
        sha256: sha256(contents),
      };
    }),
  );
  const digest = createHash("sha256");
  for (const artifact of artifacts) {
    digest.update(artifact.path);
    digest.update("\0");
    digest.update(artifact.sha256);
    digest.update("\0");
  }
  return { artifacts, treeSha256: digest.digest("hex") };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertTreesEqual(expectedRoot, actualRoot) {
  const [expectedFiles, actualFiles] = await Promise.all([
    listFiles(expectedRoot),
    listFiles(actualRoot),
  ]);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `Generated Codex protocol inventory drifted.\nExpected: ${expectedFiles.join(", ")}\nActual: ${actualFiles.join(", ")}`,
    );
  }
  for (const filename of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(expectedRoot, filename)),
      readFile(path.join(actualRoot, filename)),
    ]);
    if (!expected.equals(actual)) {
      throw new Error(`Generated Codex protocol artifact drifted: ${filename}`);
    }
  }
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Unexpected generated protocol entry: ${relative}`);
    }
  }
  return files;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function buildPathInventory(root) {
  const files = (await listFiles(root)).map((filename) =>
    filename.split(path.sep).join("/"),
  );
  const digest = createHash("sha256");
  for (const filename of files) {
    digest.update(filename);
    digest.update("\0");
  }
  return {
    count: files.length,
    pathSetSha256: digest.digest("hex"),
  };
}

function assertInstalledReleaseContract(release) {
  const platform = release.generation.supportedPlatforms.find(
    (candidate) =>
      candidate.nodePlatform === process.platform &&
      candidate.nodeArch === process.arch,
  );
  if (platform === undefined) {
    throw new Error(
      `Codex protocol generation has no reviewed artifact for ${process.platform}/${process.arch}.`,
    );
  }

  const lock = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"),
  ).packages;
  const root = lock[""];
  const packageEntry = lock["node_modules/@openai/codex"];
  const nativeEntry = lock[`node_modules/${platform.nativePackage}`];
  assertEqual(
    root?.devDependencies?.["@openai/codex"],
    release.npm.version,
    "package-lock root Codex development dependency",
  );
  assertEqual(
    packageEntry?.version,
    release.npm.version,
    "package-lock Codex version",
  );
  assertEqual(
    packageEntry?.resolved,
    release.npm.resolved,
    "package-lock Codex tarball",
  );
  assertEqual(
    packageEntry?.integrity,
    release.npm.integrity,
    "package-lock Codex integrity",
  );
  assertEqual(
    nativeEntry?.version,
    platform.nativePackageVersion,
    "package-lock native Codex version",
  );
  assertEqual(
    nativeEntry?.resolved,
    platform.nativePackageResolved,
    "package-lock native Codex tarball",
  );
  assertEqual(
    nativeEntry?.integrity,
    platform.nativePackageIntegrity,
    "package-lock native Codex integrity",
  );

  const nativeExecutable = path.join(
    repositoryRoot,
    "node_modules",
    platform.nativePackage,
    ...platform.executableRelativePath.split("/"),
  );
  const executableDigest = sha256(readFileSync(nativeExecutable));
  assertEqual(
    executableDigest,
    platform.executableSha256,
    "installed native Codex executable SHA-256",
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} does not match the pinned Codex release contract. ` +
        `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}
