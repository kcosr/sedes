import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { verifyPackageIntegrity } from "./server-package-integrity.mjs";

/** Offline validation of an already built release; installation never runs npm. */
export async function verifyServerRelease(root, environment, {
  execute = promisify(execFile), installed = false, ...compatibility
} = {}) {
  const info = await verifyPackageIntegrity(root, { installed, ...compatibility });
  const verificationEnvironment = { ...environment };
  delete verificationEnvironment.NODE_ENV;
  await execute(process.execPath, [path.join(root, "scripts", "verify-server-package.mjs"), "--package", root, ...(installed ? ["--installed"] : [])], {
    cwd: root,
    env: verificationEnvironment,
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  return info;
}
