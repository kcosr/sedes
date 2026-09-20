import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export interface E2ERunContext {
  readonly repositoryDirectory: string;
  readonly runDirectory: string;
  readonly stateDirectory: string;
  readonly workspacesDirectory: string;
  readonly screenshotsDirectory: string;
  readonly playwrightOutputDirectory: string;
  readonly reportDirectory: string;
  readonly logsDirectory: string;
  readonly jobIndex?: number;
  readonly jobTotal?: number;
}

export const e2eRepositoryDirectory = path.resolve(import.meta.dirname, "../..");

export function loadE2ERunContext(
  environment: NodeJS.ProcessEnv = process.env,
): E2ERunContext {
  const configuredRunDirectory = environment.E2E_RUN_DIR;
  if (!configuredRunDirectory) {
    throw new Error("E2E_RUN_DIR is required.");
  }
  if (!path.isAbsolute(configuredRunDirectory)) {
    throw new Error("E2E_RUN_DIR must be an absolute path.");
  }

  const runDirectory = path.resolve(configuredRunDirectory);
  if (runDirectory !== configuredRunDirectory) {
    throw new Error("E2E_RUN_DIR must be a canonical absolute path.");
  }
  const generatedRunsDirectory = path.join(
    e2eRepositoryDirectory,
    "test-results",
    "e2e-runs",
  );
  const runRelativePath = path.relative(generatedRunsDirectory, runDirectory);
  const relativeParts = runRelativePath.split(path.sep);
  const runName = relativeParts[0] ?? "";
  const isGeneratedRunName = runName.startsWith("run-") && runName !== "run-";
  const jobMatch =
    relativeParts.length === 3 && relativeParts[1] === "jobs"
      ? /^(\d{3})-of-(\d{3})$/.exec(relativeParts[2] ?? "")
      : null;
  const jobIndexText = jobMatch?.[1];
  const jobTotalText = jobMatch?.[2];
  const jobIndex =
    jobIndexText === undefined
      ? undefined
      : Number.parseInt(jobIndexText, 10);
  const jobTotal =
    jobTotalText === undefined
      ? undefined
      : Number.parseInt(jobTotalText, 10);
  const isParallelJob =
    jobIndex !== undefined &&
    jobTotal !== undefined &&
    jobIndex >= 1 &&
    jobTotal >= 2 &&
    jobIndex <= jobTotal &&
    jobTotal <= 999;
  if (
    path.isAbsolute(runRelativePath) ||
    !isGeneratedRunName ||
    (relativeParts.length !== 1 && !isParallelJob)
  ) {
    throw new Error(
      "E2E_RUN_DIR must be one generated run-* directory or one canonical run-*/jobs/NNN-of-NNN job beneath test-results/e2e-runs.",
    );
  }

  let canonicalRepositoryDirectory: string;
  let canonicalRunsDirectory: string;
  let canonicalRunDirectory: string;
  try {
    const generatedRunDirectory = path.join(generatedRunsDirectory, runName);
    const directoriesToValidate =
      relativeParts.length === 1
        ? [generatedRunDirectory]
        : [
            generatedRunDirectory,
            path.join(generatedRunDirectory, "jobs"),
            runDirectory,
          ];
    for (const directory of directoriesToValidate) {
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("run_not_canonical_directory");
      }
    }
    canonicalRepositoryDirectory = realpathSync(e2eRepositoryDirectory);
    canonicalRunsDirectory = realpathSync(generatedRunsDirectory);
    canonicalRunDirectory = realpathSync(runDirectory);
  } catch {
    throw new Error(
      "E2E_RUN_DIR must be an existing canonical generated run directory.",
    );
  }
  if (
    canonicalRunsDirectory !==
      path.join(
        canonicalRepositoryDirectory,
        "test-results",
        "e2e-runs",
      ) ||
    canonicalRunDirectory !== path.join(canonicalRunsDirectory, runRelativePath)
  ) {
    throw new Error(
      "E2E_RUN_DIR and its generated parent directories must not escape through symbolic links.",
    );
  }

  const context: E2ERunContext = {
    repositoryDirectory: e2eRepositoryDirectory,
    runDirectory,
    stateDirectory: path.join(runDirectory, "state"),
    workspacesDirectory: path.join(runDirectory, "workspaces"),
    screenshotsDirectory: path.join(runDirectory, "screenshots"),
    playwrightOutputDirectory: path.join(runDirectory, "playwright"),
    reportDirectory: path.join(runDirectory, "report"),
    logsDirectory: path.join(runDirectory, "logs"),
  };
  if (isParallelJob) {
    return { ...context, jobIndex, jobTotal };
  }
  return context;
}
