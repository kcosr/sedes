import { randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createTimingBaselineFromResult,
  parseTimingBaseline,
  serializeTimingBaseline,
  validateTimingBaselineCoverage,
} from "./e2e-runner-contract.mjs";

export const timingBaselineRelativePath = path.join(
  "tests",
  "e2e",
  "timing-baseline.json",
);

async function listSpecFilesIn(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? path.posix.join(relativeDirectory, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await listSpecFilesIn(
          path.join(directory, entry.name),
          relativePath,
        )),
      );
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function listE2ESpecFiles(repositoryRoot) {
  return (
    await listSpecFilesIn(path.join(repositoryRoot, "tests", "e2e"))
  ).sort();
}

export async function loadTimingBaseline(repositoryRoot) {
  const filename = path.join(repositoryRoot, timingBaselineRelativePath);
  let value;
  try {
    value = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("e2e_timing_baseline_json_invalid", { cause: error });
    }
    throw error;
  }
  return parseTimingBaseline(value);
}

export async function loadValidatedTimingBaseline(repositoryRoot) {
  const [baseline, specFiles] = await Promise.all([
    loadTimingBaseline(repositoryRoot),
    listE2ESpecFiles(repositoryRoot),
  ]);
  return validateTimingBaselineCoverage(baseline, specFiles);
}

export async function updateTimingBaselineFromResult(
  repositoryRoot,
  resultFilename,
) {
  const resolvedResultFilename = path.resolve(resultFilename);
  if (path.basename(resolvedResultFilename) !== "result.json") {
    throw new Error("e2e_timing_baseline_result_filename_invalid");
  }
  const runFilename = path.join(
    path.dirname(resolvedResultFilename),
    "run.json",
  );
  const [run, result, specFiles] = await Promise.all([
    readFile(runFilename, "utf8").then(JSON.parse),
    readFile(resolvedResultFilename, "utf8").then(JSON.parse),
    listE2ESpecFiles(repositoryRoot),
  ]);
  if (
    !run ||
    typeof run !== "object" ||
    Array.isArray(run) ||
    run.format !== "sedes-e2e-run-v4" ||
    !Array.isArray(run.playwrightArguments) ||
    run.playwrightArguments.length !== 0
  ) {
    throw new Error("e2e_timing_baseline_run_invalid");
  }

  const baseline = createTimingBaselineFromResult(result, specFiles);
  const baselineFilename = path.join(
    repositoryRoot,
    timingBaselineRelativePath,
  );
  const temporaryFilename = `${baselineFilename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFilename, serializeTimingBaseline(baseline), {
      flag: "wx",
    });
    await rename(temporaryFilename, baselineFilename);
  } catch (error) {
    await unlink(temporaryFilename).catch(() => {});
    throw error;
  }
  return baseline;
}
