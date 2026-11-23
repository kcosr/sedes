import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import type { ExecutionPolicyStatus, InstalledExecutionPolicy } from "../../src/internal/sidecar-protocol/execution-policy.js";
import { ConfigurationAdminService } from "../../src/server/configuration-admin/configuration-admin-service.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";
import * as environmentRuntime from "../../src/server/runtime/execution-environment-runtime.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { authenticatedProductionFetch } from "../helpers/authenticated-production-client.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

it.each(["maintenance", "impact", "removal"] as const)("publishes another host's settings while %s waits on an SSH host", async blocker => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-host-isolation-"));
  const a = randomUUID(), b = randomUUID();
  const entered = gate(), release = gate(), hostsCreated = gate();
  let armed = false, ready = false;
  const forcedRetries: string[] = [];
  const notify = new Map<string, () => void>();
  let application: RunningApplication | undefined;
  let operation: Promise<unknown> | undefined;
  const create = environmentRuntime.createExecutionEnvironmentRuntime;
  async function holdB() {
    entered.open();
    await release.promise;
  }
  vi.spyOn(environmentRuntime, "createExecutionEnvironmentRuntime").mockImplementation(async input => {
    const runtime = await create(input);
    const owner = runtime.sidecarRuntime;
    if (!owner) return runtime;
    const id = input.configured.id;
    const service = new PersistentSidecarServiceRegistry({ scope: {...input.scope, installationId: input.installationId, executionEnvironmentId: id},
      buildId: "host-isolation", artifactSha256: "d".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      configuration: input.readDesiredPolicy!().configuration });
    service.attach(input.readDesiredPolicy!().configuration);
    notify.set(id, input.onPolicyChanged!);
    if (notify.has(a) && notify.has(b)) hostsCreated.open();
    vi.spyOn(owner, "connect").mockImplementation(async () => {
      if (id === b && armed && blocker === "maintenance") await holdB();
      return service.status();
    });
    vi.spyOn(owner, "inspectService").mockImplementation(async () => {
      if (id === b && armed && blocker !== "maintenance") {
        await holdB();
        if (blocker === "removal") return undefined;
      }
      return service.status();
    });
    let installed: InstalledExecutionPolicy | undefined;
    vi.spyOn(owner, "synchronizePolicy").mockImplementation(async () => { installed = input.readDesiredPolicy!(); });
    vi.spyOn(owner, "retryPolicy").mockImplementation(async () => {
      installed = input.readDesiredPolicy!();
      forcedRetries.push(id);
      ready = true;
    });
    vi.spyOn(owner, "policyStatus").mockImplementation((): ExecutionPolicyStatus | undefined => {
      if (!installed) return undefined;
      const { snapshot, revision, digest, configuration } = installed;
      return { incarnation: service.serviceIncarnation, controllerEpoch: service.controllerEpoch, installed: {revision,digest},
        configuration, readiness: [
          ...snapshot.roots.map(r => ({id: "root:" + r.id, generation:r.generation, state:"ready" as const})),
          ...snapshot.capabilities.map(c => ({id: "capability:" + c.id, generation:c.generation, state:"ready" as const})),
          ...snapshot.backends.map(s => ({id: "backend:" + s.id, generation:s.generation, state:ready ? "ready" as const : "preparing" as const})),
        ] };
    });
    return runtime;
  });
  try {
    await writeFile(path.join(directory, "server.json"), JSON.stringify({schemaVersion:11, packagedClients:[]}));
    const getter = vi.spyOn(ConfigurationAdminService.prototype, "get");
    application = await startProductionApplication({...process.env, APP_STATE_DIR:directory, SEDES_CONFIG_FILE:path.join(directory,"server.json"), PORT:"0"});
    const address = application.server.address();
    if (!address || typeof address === "string") throw new Error("test_server_not_listening");
    const request = await authenticatedProductionFetch(application);
    expect((await request(`http://127.0.0.1:${address.port}/api/configuration`)).status).toBe(200);
    const service = getter.mock.contexts.at(-1)! as ConfigurationAdminService;
    const scope = getter.mock.calls.at(-1)![0];
    getter.mockRestore();
    const original = service.repository.get(scope);
    const configuration = structuredClone(original.configuration);
    for (const [id, alias] of [[a, "host-a"], [b, "host-b"]] as const) {
      configuration.executionEnvironments.push({id, kind:"ssh", hostAlias:alias, label:alias, workspaceRoots:["/work"], connectionCompression:true,
        operations:{kind:"sidecar", enabledCapabilities:["workspace_tools", "workspace_context"]}});
    }
    const initial = await service.save(scope, {mutationId:randomUUID(),expectedRevision:original.revision, configuration});
    await hostsCreated.promise;
    // Authentication and initial policy installation complete independently on each mocked SSH carrier.
    notify.get(a)!();
    notify.get(b)!();
    await vi.waitFor(() => expect(service.repository.runtime(scope, "environment", b).effects?.find(e => e.subjectId === "capability:workspace_tools")?.state).toBe("applied"), {timeout:5_000});
    armed = true;
    if (blocker === "maintenance") await vi.advanceTimersByTimeAsync(30_001);
    else if (blocker === "impact") operation = service.impact(scope, {resourceKind:"environment",resourceId:b,action:"restart",expectedRevision:initial.revision});
    else operation = service.save(scope, {mutationId:randomUUID(), expectedRevision:initial.revision,
      configuration:{...configuration, executionEnvironments:configuration.executionEnvironments.filter(e => e.id !== b)}});
    // Capture the outcome now: resolving the old removal proof after another document commit must fail its CAS.
    const outcome = operation?.then(() => undefined, (error: unknown) => error);
    await entered.promise;
    configuration.executionEnvironments.find(e => e.id === a)!.label = "Renamed during remote wait";
    configuration.backends.push({id:"added-pi", kind:"pi", label:"Added Pi", enabled:true, modelPolicy:{type:"catalog"}});
    configuration.targets.push({id:"added-target",kind:"pi_sdk",backendInstanceId:"added-pi",executionEnvironmentId:a,label:"Added target",enabled:true});
    const saved = await service.save(scope, {mutationId:randomUUID(),expectedRevision:initial.revision,configuration});
    expect((await service.get(scope)).configuration.executionEnvironments.find(e => e.id === a)?.label).toBe("Renamed during remote wait");
    const observed = () => service.repository.runtime(scope, "environment", a).effects?.find(e => e.subjectId === "backend:added-pi");
    await vi.waitFor(() => expect(observed()).toMatchObject({state:"awaiting_host", desiredRevision:saved.revision, lastHostConfirmation:{epoch:1}}));
    if (blocker === "maintenance") {
      const action = {resourceKind: "backend" as const, resourceId: "added-pi", action: "connect" as const, expectedRevision: saved.revision};
      const preview = await service.impact(scope, action);
      await service.lifecycle(scope, {...action, mutationId: randomUUID(), expectedIncarnation: preview.incarnation, impactToken: preview.token});
      expect(forcedRetries).toEqual([a]);
    } else {
      ready = true;
      notify.get(a)!();
    }
    await vi.waitFor(() => expect(observed()).toMatchObject({state:"applied", effectiveRevision:saved.revision}), {timeout:2000});
    release.open();
    if (blocker === "removal") expect(await outcome).toMatchObject({code:"conflict"});
    else expect(await outcome).toBeUndefined();
  } finally {
    release.open();
    await operation?.catch(() => {});
    await application?.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(directory,{recursive:true,force:true});
  }
}, 20_000);
