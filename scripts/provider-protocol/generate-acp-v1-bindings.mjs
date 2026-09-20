#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const SDK_VERSION = "1.3.0";
const SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  "node_modules/@agentclientprotocol/sdk/schema/schema.json",
);
const OUTPUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "src/server/provider-protocol/bindings/acp-v1/generated/1.3.0",
);
const GENERATED_VALIDATORS_PATH = path.join(OUTPUT_DIRECTORY, "validators.ts");
const GENERATED_PROJECTORS_PATH = path.join(OUTPUT_DIRECTORY, "projectors.ts");
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, "manifest.json");
const CLOSURE_OVERLAY_PATH = path.join(
  OUTPUT_DIRECTORY,
  "closure-overlay.json",
);
const CLOSED_SCHEMA_PATH = path.join(OUTPUT_DIRECTORY, "closed-schema.json");
const SEMANTIC_DISPOSITIONS_PATH = path.join(
  REPOSITORY_ROOT,
  "src/server/provider-protocol/bindings/acp-v1/semantic-dispositions.json",
);
const CHECK = process.argv.includes("--check");
const SCHEMA_ID = `urn:sedes:acp-sdk:${SDK_VERSION}:stable-v1`;

const ADOPTED_STABLE_V1_DEFINITIONS = Object.freeze([
  "AgentCapabilities",
  "AuthenticateRequest",
  "AuthenticateResponse",
  "CancelNotification",
  "CancelRequestNotification",
  "ClientCapabilities",
  "CloseSessionRequest",
  "CloseSessionResponse",
  "CreateTerminalRequest",
  "CreateTerminalResponse",
  "DeleteSessionRequest",
  "DeleteSessionResponse",
  "ForkSessionRequest",
  "ForkSessionResponse",
  "InitializeRequest",
  "InitializeResponse",
  "KillTerminalRequest",
  "KillTerminalResponse",
  "ListSessionsRequest",
  "ListSessionsResponse",
  "LoadSessionRequest",
  "LoadSessionResponse",
  "LogoutRequest",
  "LogoutResponse",
  "NewSessionRequest",
  "NewSessionResponse",
  "PromptRequest",
  "PromptResponse",
  "ReadTextFileRequest",
  "ReadTextFileResponse",
  "ReleaseTerminalRequest",
  "ReleaseTerminalResponse",
  "RequestPermissionRequest",
  "RequestPermissionResponse",
  "ResumeSessionRequest",
  "ResumeSessionResponse",
  "SessionNotification",
  "SetSessionConfigOptionRequest",
  "SetSessionConfigOptionResponse",
  "SetSessionModeRequest",
  "SetSessionModeResponse",
  "TerminalOutputRequest",
  "TerminalOutputResponse",
  "WaitForTerminalExitRequest",
  "WaitForTerminalExitResponse",
  "WriteTextFileRequest",
  "WriteTextFileResponse",
]);

const schemaBytes = await readFile(SCHEMA_PATH);
const officialSchema = JSON.parse(schemaBytes.toString("utf8"));
const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
const overlayBytes = await readFile(CLOSURE_OVERLAY_PATH);
const closureOverlay = JSON.parse(overlayBytes.toString("utf8"));
const semanticDispositionBytes = await readFile(SEMANTIC_DISPOSITIONS_PATH);
const semanticDispositions = JSON.parse(
  semanticDispositionBytes.toString("utf8"),
);
const adoptedDefinitions = Object.fromEntries(
  ADOPTED_STABLE_V1_DEFINITIONS.map((name) => {
    const definition = officialSchema.$defs[name];
    if (!definition)
      throw new Error(`Missing stable ACP V1 definition ${name}`);
    return [name, definition];
  }),
);

const reachableObjects = collectReachableObjectSchemas(officialSchema);
validateClosureOverlay(closureOverlay, reachableObjects, schemaSha256);
const reachableFormatPointers = collectReachableFormatPointers(officialSchema);
const reachablePropertySchemas =
  collectReachablePropertySchemas(officialSchema);
const semanticPointerCandidates = collectSemanticPointerCandidates(
  officialSchema,
  reachablePropertySchemas,
);
validateSemanticDispositions(
  semanticDispositions,
  reachableFormatPointers,
  reachablePropertySchemas,
  semanticPointerCandidates,
);
const unionBranchPointers = collectReachableUnionBranches(officialSchema);
const closedProofPointers = Object.entries(closureOverlay.classifications)
  .filter(([, classification]) => classification.startsWith("closed_"))
  .map(([pointer]) => pointer)
  .sort();
const openMapProofPointers = Object.entries(closureOverlay.classifications)
  .filter(([, classification]) => classification === "open_extension_map")
  .map(([pointer]) => pointer)
  .sort();
const { closedSchema, fenceOperations } = applyClosureOverlay(
  officialSchema,
  closureOverlay.classifications,
);
const closedSchemaSource = `${JSON.stringify(closedSchema, null, 2)}\n`;
const ajv = new Ajv2020({
  strict: true,
  strictSchema: false,
  allErrors: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  code: { source: true, esm: true, optimize: true },
});
ajv.addSchema(closedSchema, SCHEMA_ID);
const validatorReferences = Object.fromEntries(
  Object.keys(adoptedDefinitions)
    .sort()
    .map((name) => {
      const wrapperId = `${SCHEMA_ID}:validator:${name}`;
      ajv.addSchema(
        {
          $id: wrapperId,
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $ref: `${SCHEMA_ID}#/$defs/${name}`,
        },
        wrapperId,
      );
      return [`validate${name}`, wrapperId];
    }),
);
for (const reference of Object.values(validatorReferences)) {
  if (!ajv.getSchema(reference)) {
    throw new Error(`Missing adopted ACP schema definition: ${reference}`);
  }
}

let validatorSource = standaloneCode(ajv, validatorReferences);
let runtimeImports = "";
validatorSource = validatorSource.replace(
  /const (func\d+) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/g,
  (_match, binding) => {
    runtimeImports =
      'import ucs2lengthRuntime from "ajv/dist/runtime/ucs2length.js";\n';
    return `const ${binding} = typeof ucs2lengthRuntime === "function" ? ucs2lengthRuntime : ucs2lengthRuntime.default;`;
  },
);
if (validatorSource.includes("require(")) {
  throw new Error("ACP Ajv output contains an unreviewed CommonJS helper");
}
const generatedValidators = `// GENERATED CODE! DO NOT MODIFY BY HAND!\n// Source: @agentclientprotocol/sdk@${SDK_VERSION} stable V1 schema.\n// @ts-nocheck -- Ajv standalone output is generated JavaScript in the TypeScript source root.\n${runtimeImports}${validatorSource}\n`;
const projectorExports = Object.keys(adoptedDefinitions)
  .sort()
  .map(
    (name) =>
      `export function decode${name}(value: unknown): unknown | undefined { const accepted = projectAcpDefinition(value, projectionSchema, ${JSON.stringify(name)}).filter(validate${name}); return accepted.length === 1 ? accepted[0] : undefined; }`,
  )
  .join("\n");
const validatorImports = Object.keys(adoptedDefinitions)
  .sort()
  .map((name) => `validate${name}`)
  .join(", ");
const generatedProjectors = `// GENERATED CODE! DO NOT MODIFY BY HAND!\n// Source: @agentclientprotocol/sdk@${SDK_VERSION} stable V1 schema plus reviewed closure overlay.\n// @ts-nocheck -- the projection schema is a generated immutable JSON literal.\nimport { projectAcpDefinition } from "../../projection.js";\nimport { ${validatorImports} } from "./validators.js";\nconst projectionSchema = ${JSON.stringify(closedSchema)};\n${projectorExports}\n`;
const manifest = `${JSON.stringify(
  {
    artifactVersion: 3,
    sdk: `@agentclientprotocol/sdk@${SDK_VERSION}`,
    schemaSubpath: "@agentclientprotocol/sdk/schema/schema.json",
    schemaSha256,
    schemaDraft: officialSchema.$schema,
    generatedWith:
      "Ajv2020 standalone ESM over the untouched official schema plus the reviewed closure overlay; no fallback validator",
    definitions: Object.keys(adoptedDefinitions).sort(),
    semanticDispositions: {
      path: "../../semantic-dispositions.json",
      sha256: createHash("sha256")
        .update(semanticDispositionBytes)
        .digest("hex"),
      reachableIgnoredFormatPointers: reachableFormatPointers.length,
      reviewedPropertyPointers: new Set(
        semanticDispositions.pointerInventories.flatMap(
          (inventory) => inventory.pointers,
        ),
      ).size,
      selectorCandidates: Object.fromEntries(
        [...semanticPointerCandidates.entries()].map(([selector, pointers]) => [
          selector,
          pointers.length,
        ]),
      ),
      driftChecked: true,
    },
    closureOverlay: {
      path: "closure-overlay.json",
      sha256: createHash("sha256").update(overlayBytes).digest("hex"),
      reachableObjectPointers: reachableObjects.size,
      classifications: countClassifications(closureOverlay.classifications),
      fenceOperations,
      proofInventory: {
        closedMutationPointers: closedProofPointers,
        openMapMutationPointers: openMapProofPointers,
        unionBranchPointers,
      },
    },
    closedSchema: {
      path: "closed-schema.json",
      sha256: createHash("sha256").update(closedSchemaSource).digest("hex"),
      onlyAddsReviewedFences: true,
    },
    validatorArchitecture: {
      exportedValidators: Object.keys(validatorReferences).length,
      oneValidatorPerAdoptedDefinition: true,
      fallbackValidator: false,
    },
    projectorArchitecture: {
      exportedDecoders: Object.keys(adoptedDefinitions).length,
      oneDecoderPerAdoptedDefinition: true,
      schemaSha256: createHash("sha256")
        .update(JSON.stringify(closedSchema))
        .digest("hex"),
      preservesOnlyReviewedOpenMaps: true,
      fallbackProjector: false,
    },
  },
  null,
  2,
)}\n`;

if (CHECK) {
  const [
    currentValidators,
    currentProjectors,
    currentManifest,
    currentClosedSchema,
  ] =
    await Promise.all([
      readFile(GENERATED_VALIDATORS_PATH, "utf8"),
      readFile(GENERATED_PROJECTORS_PATH, "utf8"),
      readFile(MANIFEST_PATH, "utf8"),
      readFile(CLOSED_SCHEMA_PATH, "utf8"),
    ]);
  if (
    currentValidators !== generatedValidators ||
    currentProjectors !== generatedProjectors ||
    currentManifest !== manifest ||
    currentClosedSchema !== closedSchemaSource
  ) {
    throw new Error("ACP V1 generated bindings are stale");
  }
} else {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await Promise.all([
    writeFile(GENERATED_VALIDATORS_PATH, generatedValidators, "utf8"),
    writeFile(GENERATED_PROJECTORS_PATH, generatedProjectors, "utf8"),
    writeFile(MANIFEST_PATH, manifest, "utf8"),
    writeFile(CLOSED_SCHEMA_PATH, closedSchemaSource, "utf8"),
  ]);
}

function isObjectSchema(value) {
  return (
    value.type === "object" ||
    (Array.isArray(value.type) && value.type.includes("object")) ||
    value.properties != null ||
    value.additionalProperties != null
  );
}

function escapePointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectReachableObjectSchemas(schema) {
  const objects = new Map();
  const visitedDefinitions = new Set();
  const visitAt = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visitAt(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (isObjectSchema(value)) objects.set(pointer, value);
    if (typeof value.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
      if (match && !visitedDefinitions.has(match[1])) {
        const definition = schema.$defs[match[1]];
        if (!definition)
          throw new Error(`ACP schema reference missing: ${value.$ref}`);
        visitedDefinitions.add(match[1]);
        visitAt(definition, `/$defs/${escapePointer(match[1])}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visitAt(child, `${pointer}/${escapePointer(key)}`);
    }
  };
  for (const name of ADOPTED_STABLE_V1_DEFINITIONS) {
    if (visitedDefinitions.has(name)) continue;
    const definition = schema.$defs[name];
    if (!definition)
      throw new Error(`Missing stable ACP V1 definition ${name}`);
    visitedDefinitions.add(name);
    visitAt(definition, `/$defs/${escapePointer(name)}`);
  }
  return new Map(
    [...objects.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectReachableUnionBranches(schema) {
  const branches = new Set();
  const visitedDefinitions = new Set();
  const visitAt = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visitAt(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
      if (match && !visitedDefinitions.has(match[1])) {
        visitedDefinitions.add(match[1]);
        visitAt(schema.$defs[match[1]], `/$defs/${escapePointer(match[1])}`);
      }
    }
    for (const keyword of ["oneOf", "anyOf"]) {
      if (!Array.isArray(value[keyword])) continue;
      value[keyword].forEach((_member, index) =>
        branches.add(`${pointer}/${keyword}/${index}`),
      );
    }
    for (const [key, child] of Object.entries(value)) {
      visitAt(child, `${pointer}/${escapePointer(key)}`);
    }
  };
  for (const name of ADOPTED_STABLE_V1_DEFINITIONS) {
    if (visitedDefinitions.has(name)) continue;
    visitedDefinitions.add(name);
    visitAt(schema.$defs[name], `/$defs/${escapePointer(name)}`);
  }
  return [...branches].sort();
}

function collectReachableFormatPointers(schema) {
  const formats = new Map();
  const visitedDefinitions = new Set();
  const visitAt = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visitAt(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.format === "string") formats.set(pointer, value.format);
    if (typeof value.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
      if (match && !visitedDefinitions.has(match[1])) {
        const definition = schema.$defs[match[1]];
        if (!definition)
          throw new Error(`ACP schema reference missing: ${value.$ref}`);
        visitedDefinitions.add(match[1]);
        visitAt(definition, `/$defs/${escapePointer(match[1])}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref") visitAt(child, `${pointer}/${escapePointer(key)}`);
    }
  };
  for (const name of ADOPTED_STABLE_V1_DEFINITIONS) {
    if (visitedDefinitions.has(name)) continue;
    visitedDefinitions.add(name);
    visitAt(schema.$defs[name], `/$defs/${escapePointer(name)}`);
  }
  return [...formats.entries()]
    .map(([pointer, format]) => Object.freeze({ pointer, format }))
    .sort((left, right) => left.pointer.localeCompare(right.pointer));
}

function collectReachablePropertySchemas(schema) {
  const properties = new Map();
  const visitedDefinitions = new Set();
  const visitAt = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visitAt(child, `${pointer}/${index}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
      if (match && !visitedDefinitions.has(match[1])) {
        const definition = schema.$defs[match[1]];
        if (!definition)
          throw new Error(`ACP schema reference missing: ${value.$ref}`);
        visitedDefinitions.add(match[1]);
        visitAt(definition, `/$defs/${escapePointer(match[1])}`);
      }
    }
    if (value.properties && typeof value.properties === "object") {
      for (const [key, child] of Object.entries(value.properties)) {
        const childPointer = `${pointer}/properties/${escapePointer(key)}`;
        properties.set(childPointer, {
          key,
          schema: child,
          description:
            typeof child.description === "string" ? child.description : "",
        });
        visitAt(child, childPointer);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "$ref" && key !== "properties") {
        visitAt(child, `${pointer}/${escapePointer(key)}`);
      }
    }
  };
  for (const name of ADOPTED_STABLE_V1_DEFINITIONS) {
    if (visitedDefinitions.has(name)) continue;
    visitedDefinitions.add(name);
    visitAt(schema.$defs[name], `/$defs/${escapePointer(name)}`);
  }
  return new Map(
    [...properties.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function schemaAllowsType(schema, value, type, visitedDefinitions = new Set()) {
  if (!value || typeof value !== "object") return false;
  if (
    value.type === type ||
    (Array.isArray(value.type) && value.type.includes(type))
  ) {
    return true;
  }
  if (typeof value.$ref === "string") {
    const match = /^#\/\$defs\/(.+)$/u.exec(value.$ref);
    if (match && !visitedDefinitions.has(match[1])) {
      const nextVisited = new Set(visitedDefinitions);
      nextVisited.add(match[1]);
      return schemaAllowsType(
        schema,
        schema.$defs[match[1]],
        type,
        nextVisited,
      );
    }
  }
  return ["allOf", "anyOf", "oneOf"].some(
    (keyword) =>
      Array.isArray(value[keyword]) &&
      value[keyword].some((member) =>
        schemaAllowsType(schema, member, type, visitedDefinitions),
      ),
  );
}

function schemaReferencesIdentifier(value) {
  if (Array.isArray(value)) return value.some(schemaReferencesIdentifier);
  if (!value || typeof value !== "object") return false;
  if (
    typeof value.$ref === "string" &&
    /^#\/\$defs\/[^/]*Id$/u.test(value.$ref)
  ) {
    return true;
  }
  return Object.values(value).some(schemaReferencesIdentifier);
}

function collectSemanticPointerCandidates(schema, reachableProperties) {
  const selectors = new Map([
    ["portable_absolute_paths", []],
    ["uri_link_url_strings", []],
    ["timestamps", []],
    ["cursors", []],
    ["identifier_references", []],
    ["lookup_names", []],
    ["ordered_arrays", []],
  ]);
  for (const [pointer, property] of reachableProperties) {
    if (/absolute/iu.test(property.description)) {
      selectors.get("portable_absolute_paths").push(pointer);
    }
    if (
      ["uri", "link", "url"].includes(property.key) &&
      schemaAllowsType(schema, property.schema, "string")
    ) {
      selectors.get("uri_link_url_strings").push(pointer);
    }
    if (["updatedAt", "lastModified"].includes(property.key)) {
      selectors.get("timestamps").push(pointer);
    }
    if (["cursor", "nextCursor"].includes(property.key)) {
      selectors.get("cursors").push(pointer);
    }
    if (
      /\b(?:ID|identifier)\b/iu.test(property.description) ||
      schemaReferencesIdentifier(property.schema)
    ) {
      selectors.get("identifier_references").push(pointer);
    }
    if (
      property.key === "name" &&
      /(?:environment variable name|name of the environment variable|command name)/iu.test(
        property.description,
      )
    ) {
      selectors.get("lookup_names").push(pointer);
    }
    if (schemaAllowsType(schema, property.schema, "array")) {
      selectors.get("ordered_arrays").push(pointer);
    }
  }
  return new Map(
    [...selectors.entries()].map(([selector, pointers]) => [
      selector,
      [...new Set(pointers)].sort(),
    ]),
  );
}

function validateSemanticDispositions(
  dispositions,
  reachableFormats,
  reachableProperties,
  semanticPointerCandidates,
) {
  if (
    dispositions.artifactVersion !== 2 ||
    dispositions.sdk !== `@agentclientprotocol/sdk@${SDK_VERSION}` ||
    !Array.isArray(dispositions.ignoredFormatPointers) ||
    !Array.isArray(dispositions.pointerInventories) ||
    !Array.isArray(dispositions.crossFieldObligations)
  ) {
    throw new Error("ACP semantic disposition header invalid");
  }
  const reviewed = dispositions.ignoredFormatPointers
    .map(({ pointer, format }) => ({ pointer, format }))
    .sort((left, right) => left.pointer.localeCompare(right.pointer));
  if (JSON.stringify(reviewed) !== JSON.stringify(reachableFormats)) {
    throw new Error("ACP ignored-format semantic disposition drift");
  }
  const reviewedSelectors = new Map();
  for (const inventory of dispositions.pointerInventories) {
    if (
      typeof inventory.id !== "string" ||
      typeof inventory.selector !== "string" ||
      !Array.isArray(inventory.pointers) ||
      inventory.pointers.length === 0 ||
      !semanticPointerCandidates.has(inventory.selector)
    ) {
      throw new Error("ACP semantic pointer inventory invalid");
    }
    const selected = reviewedSelectors.get(inventory.selector) ?? [];
    selected.push(...inventory.pointers);
    reviewedSelectors.set(inventory.selector, selected);
  }
  if (
    JSON.stringify([...reviewedSelectors.keys()].sort()) !==
    JSON.stringify([...semanticPointerCandidates.keys()].sort())
  ) {
    throw new Error("ACP semantic pointer selector inventory drift");
  }
  for (const [selector, candidates] of semanticPointerCandidates) {
    const reviewedPointers = reviewedSelectors.get(selector).sort();
    if (
      new Set(reviewedPointers).size !== reviewedPointers.length ||
      JSON.stringify(reviewedPointers) !== JSON.stringify(candidates)
    ) {
      throw new Error(`ACP semantic pointer drift: ${selector}`);
    }
  }
  const requiredCrossFieldIds = [
    "backend_effect_scope_and_lifecycle",
    "capability_negotiation",
    "catalog_uniqueness_and_membership",
    "non_evidentiary_cross_session_state",
    "numeric_cross_field_invariants",
    "ordered_notification_authority",
    "permission_and_mutation_response_correlation",
  ];
  const reviewedCrossFieldIds = dispositions.crossFieldObligations
    .map((entry) => entry.id)
    .sort();
  if (
    new Set(reviewedCrossFieldIds).size !== reviewedCrossFieldIds.length ||
    JSON.stringify(reviewedCrossFieldIds) !==
      JSON.stringify(requiredCrossFieldIds)
  ) {
    throw new Error("ACP cross-field semantic inventory drift");
  }
  for (const entry of dispositions.crossFieldObligations) {
    if (!Array.isArray(entry.pointers) || entry.pointers.length === 0) {
      throw new Error("ACP cross-field semantic pointer inventory missing");
    }
    for (const pointer of entry.pointers) {
      if (!reachableProperties.has(pointer)) {
        throw new Error(`ACP cross-field semantic pointer stale: ${pointer}`);
      }
    }
    if (entry.id === "capability_negotiation") {
      if (
        !entry.routes ||
        typeof entry.routes !== "object" ||
        Array.isArray(entry.routes)
      ) {
        throw new Error("ACP capability route inventory missing");
      }
      const routePointers = [];
      for (const [route, pointers] of Object.entries(entry.routes)) {
        if (
          !/^(?:agent_to_client|client_to_agent)\/(?:request|notification)\/[a-z0-9_/$.-]+$/u.test(
            route,
          ) ||
          !Array.isArray(pointers) ||
          pointers.length === 0
        ) {
          throw new Error("ACP capability route inventory invalid");
        }
        for (const pointer of pointers) {
          if (!reachableProperties.has(pointer)) {
            throw new Error(`ACP capability route pointer stale: ${pointer}`);
          }
          routePointers.push(pointer);
        }
      }
      if (
        JSON.stringify([...new Set(routePointers)].sort()) !==
        JSON.stringify([...entry.pointers].sort())
      ) {
        throw new Error("ACP capability route pointer union drift");
      }
    } else if (entry.routes !== undefined) {
      throw new Error("ACP capability route inventory misplaced");
    }
  }
  for (const entry of [
    ...dispositions.ignoredFormatPointers,
    ...dispositions.pointerInventories,
    ...dispositions.crossFieldObligations,
  ]) {
    if (
      !["binding_refinement", "backend_authority", "non_evidentiary"].includes(
        entry.disposition,
      ) ||
      typeof entry.refinement !== "string" ||
      entry.refinement.length < 16 ||
      typeof entry.test !== "string" ||
      entry.test.length < 8
    ) {
      throw new Error("ACP semantic disposition entry invalid");
    }
  }
}

function validateClosureOverlay(overlay, reachableObjects, expectedSchemaHash) {
  const expectedDefinitions = [...ADOPTED_STABLE_V1_DEFINITIONS].sort();
  if (
    overlay.overlayVersion !== 1 ||
    overlay.sdk !== `@agentclientprotocol/sdk@${SDK_VERSION}` ||
    overlay.officialSchemaSha256 !== expectedSchemaHash ||
    JSON.stringify(overlay.adoptedDefinitions) !==
      JSON.stringify(expectedDefinitions) ||
    !overlay.classifications ||
    typeof overlay.classifications !== "object" ||
    Array.isArray(overlay.classifications)
  ) {
    throw new Error("ACP closure overlay header does not match the pinned SDK");
  }
  const expectedPointers = [...reachableObjects.keys()].sort();
  const classifiedPointers = Object.keys(overlay.classifications).sort();
  if (JSON.stringify(classifiedPointers) !== JSON.stringify(expectedPointers)) {
    const missing = expectedPointers.filter(
      (pointer) => !Object.hasOwn(overlay.classifications, pointer),
    );
    const stale = classifiedPointers.filter(
      (pointer) => !reachableObjects.has(pointer),
    );
    throw new Error(
      `ACP closure overlay drift: missing=${JSON.stringify(missing)} stale=${JSON.stringify(stale)}`,
    );
  }
  const allowed = new Set([
    "closed_leaf",
    "closed_composition_owner",
    "open_mixin",
    "open_extension_map",
  ]);
  const reviewedRecordPointers = Object.keys(
    overlay.reviewedOpenRecordAllowlist ?? {},
  ).sort();
  if (
    JSON.stringify(reviewedRecordPointers) !==
    JSON.stringify(["/$defs/AuthMethodTerminal/properties/env"])
  ) {
    throw new Error("ACP reviewed open-record allowlist drifted");
  }
  const reviewedEnvironmentRecord =
    overlay.reviewedOpenRecordAllowlist[reviewedRecordPointers[0]];
  if (
    reviewedEnvironmentRecord?.valueSchema !== "string" ||
    typeof reviewedEnvironmentRecord?.rationale !== "string" ||
    reviewedEnvironmentRecord.rationale.length < 32
  ) {
    throw new Error(
      "ACP reviewed environment record lacks value schema or rationale",
    );
  }
  for (const [pointer, classification] of Object.entries(
    overlay.classifications,
  )) {
    if (!allowed.has(classification)) {
      throw new Error(
        `ACP closure overlay classification invalid at ${pointer}`,
      );
    }
    const schema = reachableObjects.get(pointer);
    if (
      classification === "open_extension_map" &&
      schema.additionalProperties == null
    ) {
      throw new Error(
        `ACP extension map lost additionalProperties at ${pointer}`,
      );
    }
    if (classification === "open_extension_map") {
      const isReservedMeta =
        pointer.endsWith("/properties/_meta") &&
        typeof schema.description === "string" &&
        schema.description.includes("reserved by ACP");
      const reviewedRecord = overlay.reviewedOpenRecordAllowlist[pointer];
      if (!isReservedMeta && !reviewedRecord) {
        throw new Error(
          `ACP open extension map lacks provenance at ${pointer}`,
        );
      }
      if (
        reviewedRecord &&
        (schema.additionalProperties?.type ?? null) !==
          reviewedRecord.valueSchema
      ) {
        throw new Error(
          `ACP reviewed record value schema drifted at ${pointer}`,
        );
      }
    }
    if (
      classification === "closed_composition_owner" &&
      !["allOf", "anyOf", "oneOf"].some((keyword) =>
        Array.isArray(schema[keyword]),
      )
    ) {
      throw new Error(`ACP composition owner lost composition at ${pointer}`);
    }
    if (
      classification === "closed_leaf" &&
      ["allOf", "anyOf", "oneOf"].some((keyword) =>
        Array.isArray(schema[keyword]),
      )
    ) {
      throw new Error(`ACP closed leaf gained composition at ${pointer}`);
    }
  }
  validateOpenMixinProvenance(overlay, reachableObjects);
}

function validateOpenMixinProvenance(overlay, reachableObjects) {
  const classifications = overlay.classifications;
  const allowedMixins = new Set();
  const adoptedRootPointers = new Set(
    ADOPTED_STABLE_V1_DEFINITIONS.map(
      (name) => `/$defs/${escapePointer(name)}`,
    ),
  );
  for (const pointer of Object.keys(classifications)) {
    const match = /^(.*)\/(?:allOf|anyOf|oneOf)\/\d+$/u.exec(pointer);
    if (match && classifications[match[1]] === "closed_composition_owner") {
      allowedMixins.add(pointer);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pointer, schema] of reachableObjects) {
      if (
        classifications[pointer] !== "closed_composition_owner" &&
        !allowedMixins.has(pointer)
      ) {
        continue;
      }
      for (const member of schema.allOf ?? []) {
        if (typeof member?.$ref !== "string") continue;
        const target = member.$ref.replace(/^#/u, "");
        if (!allowedMixins.has(target)) {
          allowedMixins.add(target);
          changed = true;
        }
      }
    }
  }
  for (const [pointer, classification] of Object.entries(classifications)) {
    if (classification !== "open_mixin") continue;
    if (!allowedMixins.has(pointer) || adoptedRootPointers.has(pointer)) {
      throw new Error(
        `ACP open mixin lacks closed-owner provenance at ${pointer}`,
      );
    }
  }
  for (const pointer of allowedMixins) {
    if (
      reachableObjects.has(pointer) &&
      classifications[pointer] !== "open_mixin" &&
      classifications[pointer] !== "closed_composition_owner"
    ) {
      throw new Error(
        `ACP composition member is not classified as a mixin: ${pointer}`,
      );
    }
  }
}

function applyClosureOverlay(schema, classifications) {
  const result = structuredClone(schema);
  const fenceOperations = [];
  for (const [pointer, classification] of Object.entries(classifications)) {
    if (
      classification !== "closed_leaf" &&
      classification !== "closed_composition_owner"
    ) {
      continue;
    }
    const target = resolvePointer(result, pointer);
    const keyword =
      classification === "closed_composition_owner"
        ? "unevaluatedProperties"
        : "additionalProperties";
    if (target[keyword] === undefined) {
      target[keyword] = false;
      fenceOperations.push(Object.freeze({ pointer, keyword, value: false }));
    } else if (target[keyword] !== false) {
      throw new Error(
        `ACP closure overlay would overwrite ${pointer}/${keyword}`,
      );
    }
  }
  return { closedSchema: result, fenceOperations };
}

function resolvePointer(root, pointer) {
  let value = root;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value?.[key];
  }
  if (!value || typeof value !== "object") {
    throw new Error(`ACP closure overlay pointer missing: ${pointer}`);
  }
  return value;
}

function countClassifications(classifications) {
  const counts = {
    closed_leaf: 0,
    closed_composition_owner: 0,
    open_mixin: 0,
    open_extension_map: 0,
  };
  for (const classification of Object.values(classifications)) {
    counts[classification] += 1;
  }
  return counts;
}
