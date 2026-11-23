import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  authorizeVariableResolutionOperation,
  environmentVariablesResolveOperation,
} from "../../src/internal/sidecar-protocol/environment-variables-v1.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { ExecutionPolicyRoutes } from "../../src/server/sidecar/execution-policy-routes.js";
import { registerPersistentExecutionPolicy } from "../../src/server/sidecar/register-persistent-execution-policy.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { attachFixturePolicy } from "../helpers/execution-policy-fixture.js";

it("binds one-use variable resolution to the original backend, thread, references and normal controller", async () => {
  const configuration = { environmentRevision: 1, operationsRevision: 1 };
  const serviceRegistry = new PersistentSidecarServiceRegistry({
    scope: {
      installationId: "i",
      tenantId: "t",
      principalId: "p",
      executionEnvironmentId: "e",
    },
    buildId: "build",
    artifactSha256: "a".repeat(64),
    runtimeWireVersion: 18,
    configuration,
  });
  const snapshot = {
    roots: [],
    capabilities: [],
    backends: [
      {
        id: "one",
        kind: "codex_app_server",
        generation: 1,
        launchDigest: "a".repeat(64),
        targets: [],
      },
    ],
  };
  const epoch = attachFixturePolicy(
    serviceRegistry,
    configuration,
    "normal",
    snapshot,
  );
  const registry = new SidecarOperationRegistry();
  const routes = new ExecutionPolicyRoutes({
    readPolicy: () => serviceRegistry.executionPolicy(epoch),
    start: async () => {
      throw new Error("not requested");
    },
    executableDirectory: "/bin",
    inheritedPath: "/bin",
    endpointKey: "a".repeat(24),
    executableAvailable: async () => true,
  });
  registerPersistentExecutionPolicy({
    registry,
    peer: {
      supportsOperation: () => true,
      supportsIncomingOperation: () => true,
    },
    serviceRegistry,
    controllerEpoch: epoch,
    policyRoutes: routes,
  });
  const context = {
    requestId: randomUUID(),
    signal: new AbortController().signal,
  };
  const owner = { threadId: "thread", backendInstanceId: "one" };
  const overrides = { TEST: { kind: "literal", value: "value" } } as const;
  const prepare = async () =>
    (await registry
      .resolve(authorizeVariableResolutionOperation)!
      .handler(
        { ...owner, digest: configurationFingerprint(overrides) },
        context,
      )) as { ticket: string };
  const resolve = (request: unknown) =>
    registry
      .resolve(environmentVariablesResolveOperation)!
      .handler(request, context);
  const first = await prepare();
  await expect(
    resolve({
      ...owner,
      ...first,
      overrides: {
        TEST: {
          kind: "secret",
          source: { kind: "environment", name: "OTHER" },
        },
      },
    }),
  ).rejects.toThrow("ticket_denied");
  await expect(resolve({ ...owner, ...first, overrides })).rejects.toThrow(
    "ticket_denied",
  );
  const valid = await prepare();
  await expect(resolve({ ...owner, ...valid, overrides })).resolves.toEqual({
    values: { TEST: "value" },
  });
  await expect(resolve({ ...owner, ...valid, overrides })).rejects.toThrow(
    "ticket_denied",
  );
  const stale = await prepare();
  serviceRegistry.attach(configuration, "recovery");
  await expect(resolve({ ...owner, ...stale, overrides })).rejects.toThrow(
    "controller_stale",
  );
});
