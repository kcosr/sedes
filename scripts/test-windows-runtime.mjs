import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Native Windows runtime verification requires Windows.");
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env };
delete environment.NODE_ENV;
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run",
  "--no-file-parallelism",
  "tests/unit/windows-owned-process-native.test.ts",
  "tests/unit/windows-workspace-files.test.ts",
  "tests/unit/windows-staging-privacy.test.ts",
  "tests/unit/sidecar-windows-platform.test.ts",
  "tests/unit/sidecar-windows-ipc.test.ts",
  "tests/unit/agent-tool-cli-named-pipe.test.ts",
], { cwd: repositoryRoot, env: environment, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
