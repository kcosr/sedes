import { spawn } from "node:child_process";

// The regular coordinator owns ports, isolated state, artifacts and cleanup.
const child = spawn(process.execPath, ["scripts/run-e2e.mjs", "--lanes=1", ...process.argv.slice(2)], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, SEDES_BROWSER_BENCHMARK: "1" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
