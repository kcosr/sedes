import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  e2eRepositoryDirectory,
  loadE2ERunContext,
} from "../e2e/run-context.js";

describe("loadE2ERunContext", () => {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.splice(0).map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  it("requires an explicit absolute run directory", () => {
    expect(() => loadE2ERunContext({})).toThrow("E2E_RUN_DIR is required");
    expect(() =>
      loadE2ERunContext({ E2E_RUN_DIR: "test-results/e2e-runs/example" }),
    ).toThrow("E2E_RUN_DIR must be an absolute path");
  });

  it.each([
    path.parse(e2eRepositoryDirectory).root,
    e2eRepositoryDirectory,
    path.dirname(e2eRepositoryDirectory),
    path.join(path.dirname(e2eRepositoryDirectory), "another-checkout", "run"),
    path.join(e2eRepositoryDirectory, "test-results"),
    path.join(e2eRepositoryDirectory, "src", "run-dangerous"),
    path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
      "run-nested",
      "job",
    ),
  ])("rejects unsafe run directory %s", (runDirectory) => {
    expect(() => loadE2ERunContext({ E2E_RUN_DIR: runDirectory })).toThrow(
      /generated run|canonical generated run/,
    );
  });

  it("derives every mutable E2E path beneath an allocated run", async () => {
    const runsDirectory = path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
    );
    await mkdir(runsDirectory, { recursive: true });
    const runDirectory = await mkdtemp(path.join(runsDirectory, "run-context-"));
    cleanupDirectories.push(runDirectory);

    expect(loadE2ERunContext({ E2E_RUN_DIR: runDirectory })).toEqual({
      repositoryDirectory: e2eRepositoryDirectory,
      runDirectory,
      stateDirectory: path.join(runDirectory, "state"),
      workspacesDirectory: path.join(runDirectory, "workspaces"),
      screenshotsDirectory: path.join(runDirectory, "screenshots"),
      playwrightOutputDirectory: path.join(runDirectory, "playwright"),
      reportDirectory: path.join(runDirectory, "report"),
      logsDirectory: path.join(runDirectory, "logs"),
    });
  });

  it("accepts a canonical three-digit parallel job and derives private paths", async () => {
    const runsDirectory = path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
    );
    await mkdir(runsDirectory, { recursive: true });
    const generatedRunDirectory = await mkdtemp(
      path.join(runsDirectory, "run-context-jobs-"),
    );
    cleanupDirectories.push(generatedRunDirectory);
    const jobDirectory = path.join(
      generatedRunDirectory,
      "jobs",
      "002-of-016",
    );
    await mkdir(jobDirectory, { recursive: true });

    expect(loadE2ERunContext({ E2E_RUN_DIR: jobDirectory })).toEqual({
      repositoryDirectory: e2eRepositoryDirectory,
      runDirectory: jobDirectory,
      stateDirectory: path.join(jobDirectory, "state"),
      workspacesDirectory: path.join(jobDirectory, "workspaces"),
      screenshotsDirectory: path.join(jobDirectory, "screenshots"),
      playwrightOutputDirectory: path.join(jobDirectory, "playwright"),
      reportDirectory: path.join(jobDirectory, "report"),
      logsDirectory: path.join(jobDirectory, "logs"),
      jobIndex: 2,
      jobTotal: 16,
    });
  });

  it.each([
    "02-of-016",
    "002-of-16",
    "000-of-016",
    "017-of-016",
    "001-of-001",
    "001-of-1000",
    "001-of-000",
    "not-a-job",
  ])("rejects invalid parallel job name %s", async (jobName) => {
    const runsDirectory = path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
    );
    await mkdir(runsDirectory, { recursive: true });
    const generatedRunDirectory = await mkdtemp(
      path.join(runsDirectory, "run-context-invalid-job-"),
    );
    cleanupDirectories.push(generatedRunDirectory);
    const jobDirectory = path.join(generatedRunDirectory, "jobs", jobName);
    await mkdir(jobDirectory, { recursive: true });

    expect(() => loadE2ERunContext({ E2E_RUN_DIR: jobDirectory })).toThrow(
      /generated run|canonical/,
    );
  });

  it("rejects a parallel job beneath a symbolic jobs directory", async () => {
    const runsDirectory = path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
    );
    await mkdir(runsDirectory, { recursive: true });
    const generatedRunDirectory = await mkdtemp(
      path.join(runsDirectory, "run-context-job-symlink-"),
    );
    const outsideDirectory = await mkdtemp(
      path.join(tmpdir(), "sedes-e2e-jobs-"),
    );
    cleanupDirectories.push(generatedRunDirectory, outsideDirectory);
    const jobDirectory = path.join(outsideDirectory, "001-of-002");
    await mkdir(jobDirectory, { recursive: true });
    await symlink(
      outsideDirectory,
      path.join(generatedRunDirectory, "jobs"),
      "dir",
    );

    expect(() =>
      loadE2ERunContext({
        E2E_RUN_DIR: path.join(
          generatedRunDirectory,
          "jobs",
          "001-of-002",
        ),
      }),
    ).toThrow(/canonical generated run directory/);
  });

  it("rejects a generated-looking symbolic link", async () => {
    const runsDirectory = path.join(
      e2eRepositoryDirectory,
      "test-results",
      "e2e-runs",
    );
    await mkdir(runsDirectory, { recursive: true });
    const outsideDirectory = await mkdtemp(
      path.join(tmpdir(), "sedes-e2e-run-context-"),
    );
    const runDirectory = path.join(
      runsDirectory,
      `run-symlink-${path.basename(outsideDirectory)}`,
    );
    cleanupDirectories.push(runDirectory, outsideDirectory);
    await symlink(outsideDirectory, runDirectory, "dir");

    expect(() => loadE2ERunContext({ E2E_RUN_DIR: runDirectory })).toThrow(
      /canonical generated run directory/,
    );
  });
});
