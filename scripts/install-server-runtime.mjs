import { execFile } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { verifyPackageIntegrity } from "./server-package-integrity.mjs";

/** Offline validation of an already built release; installation never runs npm. */
export async function verifyServerRelease(root, environment, {
  execute = promisify(execFile), installed = false, ...compatibility
} = {}) {
  const canonicalRoot = await realpath(root);
  const info = await verifyPackageIntegrity(canonicalRoot, { installed, ...compatibility });
  const verificationEnvironment = { ...environment };
  delete verificationEnvironment.NODE_ENV;
  const result = await execute(process.execPath, [path.join(canonicalRoot, "scripts", "verify-server-package.mjs"), "--package", canonicalRoot, ...(installed ? ["--installed"] : [])], {
    cwd: canonicalRoot,
    env: verificationEnvironment,
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  let report;
  try { report = JSON.parse(result?.stdout); } catch { /* Refuse absent or malformed reports below. */ }
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      Object.keys(report).length !== 2 || report.liveProviders !== false ||
      !Array.isArray(report.checks) || report.checks.length === 0 ||
      !report.checks.every(check => typeof check === "string" && check.trim().length > 0)) {
    throw new Error("server_package_verifier_report_invalid: verifier must report nonempty checks and liveProviders:false before activation.");
  }
  return info;
}
