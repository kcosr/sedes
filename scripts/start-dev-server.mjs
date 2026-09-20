import { spawn } from "node:child_process";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const executable = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const environment = {
  ...process.env,
  NODE_ENV: "development",
  PORT: process.env.PORT ?? "4784",
  SEDES_CONFIG_FILE:
    process.env.SEDES_CONFIG_FILE ??
    path.join(repositoryRoot, "config", "server.example.json"),
};

const child = spawn(executable, ["watch", "src/server/index.ts"], {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
});

let terminating = false;
const forward = (signal) => {
  if (terminating) return;
  terminating = true;
  child.kill(signal);
};

process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

child.once("error", (error) => {
  process.stderr.write(`Unable to start the Sedes development server: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal && !terminating) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
