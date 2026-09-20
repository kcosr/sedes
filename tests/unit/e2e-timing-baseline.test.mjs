import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listE2ESpecFiles,
  loadValidatedTimingBaseline,
  updateTimingBaselineFromResult,
} from "../../scripts/e2e-timing-baseline.mjs";
import { timingBaselineFormat } from "../../scripts/e2e-runner-contract.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function createRepositoryFixture() {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "sedes-e2e-timing-baseline-"),
  );
  temporaryDirectories.push(repositoryRoot);
  const e2eDirectory = path.join(repositoryRoot, "tests", "e2e");
  const runDirectory = path.join(repositoryRoot, "test-results", "run-source");
  await Promise.all([
    mkdir(e2eDirectory, { recursive: true }),
    mkdir(runDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(e2eDirectory, "a.spec.ts"), "// a\n"),
    writeFile(path.join(e2eDirectory, "b.spec.ts"), "// b\n"),
    writeFile(
      path.join(e2eDirectory, "timing-baseline.json"),
      `${JSON.stringify({
        format: timingBaselineFormat,
        jobs: [
          { file: "a.spec.ts", estimatedMilliseconds: 1_000 },
          { file: "b.spec.ts", estimatedMilliseconds: 1_000 },
        ],
      })}\n`,
    ),
  ]);
  return { repositoryRoot, e2eDirectory, runDirectory };
}

async function writeSuccessfulRun(runDirectory, overrides = {}) {
  await Promise.all([
    writeFile(
      path.join(runDirectory, "run.json"),
      `${JSON.stringify({
        format: "sedes-e2e-run-v4",
        playwrightArguments: [],
        ...overrides.run,
      })}\n`,
    ),
    writeFile(
      path.join(runDirectory, "result.json"),
      `${JSON.stringify({
        format: "sedes-e2e-result-v1",
        exitCode: 0,
        matchingJobs: [
          { file: "a.spec.ts", testCount: 1 },
          { file: "b.spec.ts", testCount: 2 },
        ],
        jobs: [
          {
            file: "b.spec.ts",
            exitCode: 0,
            playwrightStarted: true,
            totalMilliseconds: 2_600,
          },
          {
            file: "a.spec.ts",
            exitCode: 0,
            playwrightStarted: true,
            totalMilliseconds: 1_400,
          },
        ],
        ...overrides.result,
      })}\n`,
    ),
  ]);
}

describe("E2E timing baseline files", () => {
  it("discovers specs and atomically writes only rounded scheduling data", async () => {
    const { repositoryRoot, runDirectory } = await createRepositoryFixture();
    await writeSuccessfulRun(runDirectory);

    expect(await listE2ESpecFiles(repositoryRoot)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
    ]);
    await updateTimingBaselineFromResult(
      repositoryRoot,
      path.join(runDirectory, "result.json"),
    );
    expect(await loadValidatedTimingBaseline(repositoryRoot)).toEqual({
      format: timingBaselineFormat,
      jobs: [
        { file: "a.spec.ts", estimatedMilliseconds: 1_000 },
        { file: "b.spec.ts", estimatedMilliseconds: 3_000 },
      ],
    });
    expect(
      await readFile(
        path.join(repositoryRoot, "tests", "e2e", "timing-baseline.json"),
        "utf8",
      ),
    ).not.toMatch(/completedAt|exitCode|testCount|playwrightStarted/);
  });

  it("rejects targeted, failed, and incomplete source runs", async () => {
    for (const overrides of [
      { run: { playwrightArguments: ["a.spec.ts"] } },
      { result: { exitCode: 1 } },
      {
        result: {
          matchingJobs: [{ file: "a.spec.ts", testCount: 1 }],
          jobs: [
            {
              file: "a.spec.ts",
              exitCode: 0,
              playwrightStarted: true,
              totalMilliseconds: 1_000,
            },
          ],
        },
      },
    ]) {
      const { repositoryRoot, runDirectory } = await createRepositoryFixture();
      await writeSuccessfulRun(runDirectory, overrides);
      await expect(
        updateTimingBaselineFromResult(
          repositoryRoot,
          path.join(runDirectory, "result.json"),
        ),
      ).rejects.toThrow(/e2e_timing_baseline/);
    }
  });
});
