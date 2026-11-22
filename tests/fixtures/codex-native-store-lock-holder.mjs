import { createCodexNativeStoreLifecycle } from "../../src/server/backends/codex/codex-native-store-lock.ts";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.ts";

import { randomUUID } from "node:crypto";
import { createSidecarLaunchLedger } from "../../src/server/sidecar/sidecar-launch-ledger.ts";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.ts";

const [codexHome, serviceDirectory, scopeJson] = process.argv.slice(2);
try {
  let sidecar;
  if (serviceDirectory) {
    const owner = {
      serviceIncarnation: randomUUID(),
      process: await sidecarProcessOwnership.readProcess(process.pid),
      lifetime: await sidecarProcessOwnership.readTargetLifetime(),
      scope: JSON.parse(scopeJson),
    };
    await createSidecarLaunchLedger(serviceDirectory, owner);
    sidecar = { serviceDirectory, owner, backendInstanceId: "codex-fixture" };
  }
  const lease = await createCodexNativeStoreLifecycle({
    canonicalCodexHome: codexHome,
    label: "fixture",
    sidecar,
    ownership: new CodexNativeStoreOwnershipGate(),
  }).acquire();
  process.stdout.write("acquired\n");
  process.stdin.resume();
  process.stdin.once("end", async () => {
    await lease.release();
    process.exit(0);
  });
} catch (error) {
  process.stdout.write(`error:${error.message}\n`);
  process.exit(2);
}
