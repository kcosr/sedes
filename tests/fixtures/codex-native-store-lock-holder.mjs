import { createCodexNativeStoreLifecycle } from "../../src/server/backends/codex/codex-native-store-lock.ts";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.ts";

const codexHome = process.argv[2];
try {
  const lease = await createCodexNativeStoreLifecycle({
    canonicalCodexHome: codexHome,
    label: "fixture",
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
