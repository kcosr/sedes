import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Compiles the provider `sedes` executable into an isolated directory so a
 * test exercises the generated executable without requiring (or mutating) the
 * repository's dist tree. Keeping the directory below the repository also
 * preserves normal Node package resolution for the emitted CLI's runtime
 * dependencies. The caller owns removing `buildRoot`.
 */
export async function buildSedesToolExecutable(): Promise<{
  readonly executable: string;
  readonly buildRoot: string;
}> {
  const buildRoot = await mkdtemp(path.resolve(".agent-tool-cli-test-build-"));
  const outputRoot = path.join(buildRoot, "output");
  const compilerConfiguration = path.join(buildRoot, "tsconfig.json");
  await writeFile(
    compilerConfiguration,
    JSON.stringify({
      extends: path.resolve("tsconfig.server.json"),
      compilerOptions: { outDir: outputRoot },
      include: [],
      files: [path.resolve("src/cli/provider-bin/sedes.ts")],
    }),
    "utf8",
  );
  await execFileAsync(
    process.execPath,
    [
      path.resolve("node_modules/typescript/bin/tsc"),
      "--project",
      compilerConfiguration,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const compiledExecutable = path.join(
    outputRoot,
    "cli",
    "provider-bin",
    "sedes.js",
  );
  const executable = path.join(outputRoot, "cli", "provider-bin", "sedes");
  await copyFile(compiledExecutable, executable);
  await chmod(executable, 0o755);
  return { executable, buildRoot };
}
