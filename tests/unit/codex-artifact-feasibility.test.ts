import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS,
  CODEX_APP_SERVER_RELEASE,
  CODEX_CLIENT_NOTIFICATION_METHODS,
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_EXPERIMENTAL_CLIENT_REQUEST_METHODS,
  CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY,
  CODEX_SERVER_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CodexAppServerBindingError,
  assertCodexAttestedServerNotificationParams,
  assertCodexAttestedServerRequestParams,
  decodeCodexServerNotificationEnvelope,
  decodeCodexServerNotificationParams,
  decodeCodexServerRequestParams,
  defineCodexAppServerMethod,
  encodeCodexClientNotification,
  encodeCodexServerRequestResult,
  validateCodexServerNotificationEnvelope,
  type OfficialCodexClientRequestParams,
  type OfficialCodexClientRequestResult,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const adoptionManifest = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      "protocol/codex-app-server/0.153.0/adoption-manifest.json",
    ),
    "utf8",
  ),
) as {
  productionRelease: string;
  productionRuntimeCompatibility: { currentPolicy: string };
  routes: Array<{
    direction: string;
    method: string;
    stability: "stable" | "experimental";
    artifactProfile: "stable" | "experimental";
    use: string;
  }>;
};
const stableProtocolManifest = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      "protocol/codex-app-server/0.153.0/protocol-manifest.json",
    ),
    "utf8",
  ),
) as { methods: { clientRequests: string[]; serverNotifications: string[] } };
const experimentalProtocolManifest = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      "protocol/codex-app-server/0.153.0/protocol-manifest-experimental.json",
    ),
    "utf8",
  ),
) as { methods: { clientRequests: string[] } };

type JsonSchema = {
  readonly $ref?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly type?: string | readonly string[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
};
type JsonSchemaDocument = JsonSchema & {
  readonly definitions: Readonly<Record<string, JsonSchema>>;
};

const stableV2Schema = readSchema("generated");
const experimentalV2Schema = readSchema("generated-experimental");
const officialServerNotificationDefinitions = new Map(
  [...readFileSync(
    path.join(
      repositoryRoot,
      "protocol/codex-app-server/0.153.0/official/stable/typescript/ServerNotification.ts",
    ),
    "utf8",
  ).matchAll(/\{ "method": "([^"]+)", "params": ([A-Za-z0-9_]+) \}/gu)].map(
    (match) => [match[1]!, match[2]!] as const,
  ),
);

function readSchema(profile: "generated" | "generated-experimental") {
  return JSON.parse(
    readFileSync(
      path.join(
        repositoryRoot,
        `protocol/codex-app-server/0.153.0/${profile}/json-schema/codex_app_server_protocol.v2.schemas.json`,
      ),
      "utf8",
    ),
  ) as JsonSchemaDocument;
}

function minimalOfficialFixture(
  schema: JsonSchema,
  document: JsonSchemaDocument,
  resolving = new Set<string>(),
): unknown {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/definitions/", "");
    const definition = document.definitions[name];
    if (!definition || resolving.has(name)) {
      throw new Error(`unsupported_recursive_fixture:${name}`);
    }
    const next = new Set(resolving);
    next.add(name);
    return minimalOfficialFixture(definition, document, next);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.anyOf) {
    const nullable = schema.anyOf.find((entry) => entry.type === "null");
    return minimalOfficialFixture(nullable ?? schema.anyOf[0]!, document, resolving);
  }
  if (schema.oneOf) {
    const branch = minimalOfficialFixture(schema.oneOf[0]!, document, resolving);
    if (schema.properties || schema.required) {
      const siblings = minimalOfficialFixture(
        { ...schema, oneOf: undefined },
        document,
        resolving,
      );
      if (
        typeof branch === "object" &&
        branch !== null &&
        typeof siblings === "object" &&
        siblings !== null
      ) {
        return Object.assign({}, siblings, branch);
      }
    }
    return branch;
  }
  if (schema.allOf) {
    const values = schema.allOf.map((entry) =>
      minimalOfficialFixture(entry, document, resolving),
    );
    if (values.length === 1) return values[0];
    if (values.every((value) => typeof value === "object" && value !== null)) {
      return Object.assign({}, ...values);
    }
    return values[0];
  }
  const selectedType = Array.isArray(schema.type)
    ? schema.type.includes("null")
      ? "null"
      : schema.type[0]
    : schema.type ?? (schema.properties ? "object" : undefined);
  switch (selectedType) {
    case "null":
      return null;
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [
          key,
          minimalOfficialFixture(schema.properties?.[key] ?? {}, document, resolving),
        ]),
      );
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () =>
        minimalOfficialFixture(schema.items ?? {}, document, resolving),
      );
    case "string":
      return "x".repeat(schema.minLength ?? 0);
    case "integer":
    case "number":
      return schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? 0
          : schema.exclusiveMinimum + 1);
    case "boolean":
      return false;
    default:
      return null;
  }
}

describe("Codex D3 production app-server binding", () => {
  it("exposes generated official types through the server-private facade", () => {
    const params = {
      threadId: "thread-1",
      effort: "high",
    } satisfies OfficialCodexClientRequestParams<"thread/settings/update">;
    const result = {} satisfies OfficialCodexClientRequestResult<"thread/settings/update">;
    expectTypeOf(params).toMatchTypeOf<
      OfficialCodexClientRequestParams<"thread/settings/update">
    >();
    expectTypeOf(result).toMatchTypeOf<
      OfficialCodexClientRequestResult<"thread/settings/update">
    >();
    expectTypeOf<
      OfficialCodexClientRequestParams<"thread/turns/list">
    >().toMatchTypeOf<{ threadId: string }>();
    expectTypeOf<
      OfficialCodexClientRequestResult<"thread/turns/list">
    >().toMatchTypeOf<{ data: unknown[] }>();
    expectTypeOf<
      OfficialCodexClientRequestParams<"thread/items/list">
    >().toMatchTypeOf<{ threadId: string }>();
    expectTypeOf<
      OfficialCodexClientRequestResult<"thread/items/list">
    >().toMatchTypeOf<{ data: unknown[] }>();
  });

  it("keeps the manifest and generated production registries exactly aligned", () => {
    expect(CODEX_APP_SERVER_RELEASE).toBe("0.153.0");
    expect(adoptionManifest.productionRelease).toBe("0.153.0");
    expect(adoptionManifest.productionRuntimeCompatibility.currentPolicy).toBe(
      "stable releases at or above 0.153.0 using exactly the 0.153.0 parser profile",
    );
    expect(adoptionManifest.routes).toHaveLength(66);

    const byDirection = adoptionManifest.routes.reduce<
      Record<string, typeof adoptionManifest.routes>
    >((groups, route) => {
      (groups[route.direction] ??= []).push(route);
      return groups;
    }, {});
    expect(byDirection.client_request).toHaveLength(24);
    expect(byDirection.client_notification).toHaveLength(1);
    expect(byDirection.server_request).toHaveLength(10);
    expect(byDirection.server_notification).toHaveLength(31);

    expect(
      byDirection.client_request!
        .filter((route) => route.use === "codec_only")
        .map((route) => route.method),
    ).toEqual([]);
    expect(
      byDirection.client_request!.filter((route) => route.use === "invoked"),
    ).toHaveLength(24);

    expect(methods(byDirection.client_request)).toEqual(
      [...CODEX_CLIENT_REQUEST_METHODS].sort(),
    );
    expect(methods(byDirection.client_notification)).toEqual(
      [...CODEX_CLIENT_NOTIFICATION_METHODS].sort(),
    );
    expect(methods(byDirection.server_request)).toEqual(
      [...CODEX_SERVER_REQUEST_METHODS].sort(),
    );
    expect(methods(byDirection.server_notification)).toEqual(
      [...CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS].sort(),
    );
    expect([...CODEX_SERVER_NOTIFICATION_METHODS].sort()).toEqual(
      [...stableProtocolManifest.methods.serverNotifications].sort(),
    );
    expect(CODEX_SERVER_NOTIFICATION_METHODS).toHaveLength(83);
  });

  it("separates method stability from the nine selected experimental artifacts", () => {
    expect(CODEX_EXPERIMENTAL_CLIENT_REQUEST_METHODS).toEqual([
      "thread/settings/update",
    ]);
    const experimentalArtifacts = adoptionManifest.routes.filter(
      (route) => route.artifactProfile === "experimental",
    );
    expect(experimentalArtifacts).toHaveLength(9);
    expect(
      experimentalArtifacts
        .map((route) => `${route.direction}:${route.method}`)
        .sort(),
    ).toEqual([
      "client_request:thread/fork",
      "client_request:thread/list",
      "client_request:thread/read",
      "client_request:thread/resume",
      "client_request:thread/settings/update",
      "client_request:thread/start",
      "server_notification:thread/settings/updated",
      "server_notification:thread/started",
      "server_request:item/commandExecution/requestApproval",
    ]);
    expect(
      adoptionManifest.routes
        .filter((route) => route.stability === "experimental")
        .map((route) => route.method),
    ).toEqual(["thread/settings/update"]);
    for (const method of ["thread/turns/list", "thread/items/list"]) {
      expect(stableProtocolManifest.methods.clientRequests).toContain(method);
      expect(experimentalProtocolManifest.methods.clientRequests).toContain(
        method,
      );
      expect(
        adoptionManifest.routes.find(
          (route) =>
            route.direction === "client_request" && route.method === method,
        )?.artifactProfile,
      ).toBe("stable");
    }
  });

  it("admits an official-valid fixture through every exact notification route", () => {
    expect(officialServerNotificationDefinitions.size).toBe(83);
    const artifactProfileByMethod = new Map(
      adoptionManifest.routes
        .filter((route) => route.direction === "server_notification")
        .map((route) => [route.method, route.artifactProfile] as const),
    );
    for (const method of CODEX_SERVER_NOTIFICATION_METHODS) {
      const definition = officialServerNotificationDefinitions.get(method);
      expect(definition, method).toBeDefined();
      const document =
        artifactProfileByMethod.get(method) === "experimental"
          ? experimentalV2Schema
          : stableV2Schema;
      const schema = document.definitions[definition!];
      expect(schema, `${method}:${definition}`).toBeDefined();
      const params = minimalOfficialFixture(schema!, document);
      expect(
        () => decodeCodexServerNotificationEnvelope(method, params),
        method,
      ).not.toThrow();
    }
  });

  it("keeps reviewed thread-route evidence aligned with each selected official profile", () => {
    const artifactProfileByMethod = new Map(
      adoptionManifest.routes
        .filter((route) => route.direction === "server_notification")
        .map((route) => [route.method, route.artifactProfile] as const),
    );
    const derivedRoutes = Object.fromEntries(
      CODEX_SERVER_NOTIFICATION_METHODS.flatMap((method) => {
        const definition = officialServerNotificationDefinitions.get(method);
        expect(definition, method).toBeDefined();
        const artifactProfile =
          artifactProfileByMethod.get(method) === "experimental"
            ? "experimental"
            : "stable";
        const document =
          artifactProfile === "experimental"
            ? experimentalV2Schema
            : stableV2Schema;
        const schema = document.definitions[definition!];
        expect(schema, `${method}:${definition}`).toBeDefined();
        const properties = collectSchemaProperties(schema!, document);
        const path = properties.has("threadId")
          ? "threadId"
          : properties.has("thread") &&
              collectSchemaProperties(properties.get("thread")!, document).has(
                "id",
              )
            ? "thread.id"
            : undefined;
        return path
          ? [[method, { artifactProfile, path }] as const]
          : [];
      }),
    );

    expect(Object.keys(derivedRoutes)).toHaveLength(63);
    expect(CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY).toEqual(derivedRoutes);
  });

  it("covers the two notifications omitted from the aggregate official schema", () => {
    expect(() =>
      decodeCodexServerNotificationEnvelope("rawResponse/completed", {
        responseId: "response-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: null,
        usageMetadata: null,
      }),
    ).not.toThrow();
    expect(() =>
      decodeCodexServerNotificationEnvelope("rawResponseItem/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "message", role: "assistant", content: [] },
      }),
    ).not.toThrow();
    expect(
      validateCodexServerNotificationEnvelope("rawResponse/completed", {
        responseId: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toBe(false);
    expect(
      validateCodexServerNotificationEnvelope("rawResponseItem/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: null,
      }),
    ).toBe(false);
  });

  it("executes every binding direction and rejects malformed values", () => {
    const settings = defineCodexAppServerMethod({
      method: "thread/settings/update",
      refineParams: (value) => value,
      refineResult: (value) => value,
    });
    expect(settings.encodeParams({ threadId: "thread-1", effort: "high" })).toEqual(
      { threadId: "thread-1", effort: "high" },
    );
    expect(settings.decodeResult({})).toEqual({});
    expect(() => settings.encodeParams({ effort: "high" } as never)).toThrow(
      CodexAppServerBindingError,
    );

    expect(encodeCodexClientNotification("initialized")).toEqual({
      method: "initialized",
    });
    expect(decodeCodexServerRequestParams("attestation/generate", {})).toEqual(
      {},
    );
    expect(encodeCodexServerRequestResult("attestation/generate", {
      token: "opaque",
    })).toEqual({ token: "opaque" });
    expect(() =>
      encodeCodexServerRequestResult("attestation/generate", { token: 3 }),
    ).toThrow(CodexAppServerBindingError);
    expect(
      decodeCodexServerNotificationParams("skills/changed", {}),
    ).toEqual({});
  });

  it("admits valid non-adopted stable notifications without widening consumers", () => {
    expect(CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS).not.toContain(
      "mcpServer/oauthLogin/completed",
    );
    expect(
      validateCodexServerNotificationEnvelope(
        "mcpServer/oauthLogin/completed",
        { name: "server-1", threadId: null, success: true },
      ),
    ).toBe(true);
    expect(
      validateCodexServerNotificationEnvelope(
        "mcpServer/oauthLogin/completed",
        { name: 1, threadId: null, success: true },
      ),
    ).toBe(false);
    for (const method of [
      "thread/queue/changed",
      "thread/reverted",
    ] as const) {
      expect(CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS).not.toContain(method);
      expect(
        validateCodexServerNotificationEnvelope(method, {
          threadId: "thread-1",
        }),
      ).toBe(true);
    }
    for (const [method, params] of [
      [
        "project/changed",
        { projectId: "project-1", changeType: "updated" },
      ],
      [
        "thread/project/updated",
        { threadId: "thread-1", projectId: null },
      ],
      [
        "autoApprovalReview/strictReviewRequired",
        { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1 },
      ],
    ] as const) {
      expect(CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS).not.toContain(method);
      expect(validateCodexServerNotificationEnvelope(method, params)).toBe(true);
    }
  });

  it("attests only immutable exact-method inbound snapshots", () => {
    const rawRequest = {};
    const request = decodeCodexServerRequestParams(
      "attestation/generate",
      rawRequest,
    );
    expect(request).not.toBe(rawRequest);
    expect(Object.isFrozen(request)).toBe(true);
    expect(
      assertCodexAttestedServerRequestParams("attestation/generate", request),
    ).toBe(request);
    expect(() =>
      assertCodexAttestedServerRequestParams(
        "account/chatgptAuthTokens/refresh",
        request,
      ),
    ).toThrow(CodexAppServerBindingError);
    expect(() =>
      assertCodexAttestedServerNotificationParams("skills/changed", request),
    ).toThrow(CodexAppServerBindingError);
    expect(() =>
      assertCodexAttestedServerRequestParams(
        "attestation/generate",
        structuredClone(request),
      ),
    ).toThrow(CodexAppServerBindingError);

    const rawNotification = { message: "bounded warning" };
    const notification = decodeCodexServerNotificationEnvelope(
      "warning",
      rawNotification,
    ) as { readonly message: string };
    expect(notification).not.toBe(rawNotification);
    expect(Object.isFrozen(notification)).toBe(true);
    expect(() => {
      (notification as { message: string }).message = "mutated";
    }).toThrow();
    expect(notification.message).toBe("bounded warning");
  });

  it("redacts validator and refinement failures", () => {
    const marker = "provider-secret-marker";
    const method = defineCodexAppServerMethod({
      method: "thread/settings/update",
      refineParams: () => {
        throw new Error(marker);
      },
      refineResult: () => {
        throw new Error(marker);
      },
    });
    for (const operation of [
      () => method.encodeParams({ threadId: "thread-1" }),
      () => method.decodeResult({}),
    ]) {
      try {
        operation();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CodexAppServerBindingError);
        expect((error as Error).cause).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(marker);
        expect(String(error)).not.toContain(marker);
      }
    }
  });

  it("rejects behavioral JSON objects before attesting outbound wire values", () => {
    const marker = "provider-secret-marker";
    const settings = defineCodexAppServerMethod({
      method: "thread/settings/update",
      refineParams: (value) => value,
      refineResult: (value) => value,
    });
    const behavioralParams = Object.create({
      toJSON: () => ({ threadId: marker }),
    }) as { threadId: string };
    behavioralParams.threadId = "thread-1";
    expect(() => settings.encodeParams(behavioralParams)).toThrow(
      CodexAppServerBindingError,
    );

    const behavioralResult = {} as { token: string };
    Object.defineProperty(behavioralResult, "token", {
      enumerable: true,
      get: () => marker,
    });
    expect(() =>
      encodeCodexServerRequestResult(
        "attestation/generate",
        behavioralResult,
      ),
    ).toThrow(CodexAppServerBindingError);
  });
});

function methods(
  routes: Array<{ readonly method: string }> | undefined,
): string[] {
  return (routes ?? []).map((route) => route.method).sort();
}

function collectSchemaProperties(
  schema: JsonSchema,
  document: JsonSchemaDocument,
  resolving = new Set<string>(),
): Map<string, JsonSchema> {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/definitions/", "");
    const definition = document.definitions[name];
    if (!definition || resolving.has(name)) return new Map();
    const next = new Set(resolving);
    next.add(name);
    return collectSchemaProperties(definition, document, next);
  }
  const properties = new Map(Object.entries(schema.properties ?? {}));
  for (const branch of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    for (const [name, property] of collectSchemaProperties(
      branch,
      document,
      resolving,
    )) {
      properties.set(name, property);
    }
  }
  return properties;
}
