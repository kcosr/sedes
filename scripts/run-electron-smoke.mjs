import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const smokeScript = path.join(
  repositoryRoot,
  "scripts",
  "smoke-electron-client.mjs",
);
const mode = process.argv[2] ?? "--source";
const profileArguments = process.argv.slice(3);
if (profileArguments.length && (profileArguments.length !== 2 || profileArguments[0] !== "--profile" || !["client", "full"].includes(profileArguments[1]))) throw new Error("Invalid Electron smoke profile");
if (mode !== "--source" && mode !== "--packaged") {
  throw new Error("Usage: run-electron-smoke.mjs [--source|--packaged]");
}
const useVirtualDisplay = process.platform === "linux" && !process.env.DISPLAY;
const command = useVirtualDisplay ? "xvfb-run" : process.execPath;
const arguments_ = useVirtualDisplay
  ? ["-a", process.execPath, "--import", "tsx", smokeScript, mode, ...profileArguments]
  : ["--import", "tsx", smokeScript, mode, ...profileArguments];
const result = spawnSync(command, arguments_, {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
