import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  createE2EEnvironment,
  createTimingBaselineFromResult,
  discoveryJobs,
  effectiveLaneCount,
  estimateJobDuration,
  estimateJobDurationWithSource,
  parseTimingBaseline,
  parseRunnerArguments,
  prebuiltArtifactPaths,
  signalExitCode,
  sortJobsByEstimatedDuration,
  timingBaselineFormat,
  timingObservationsFromResult,
  validateReadyMessage,
  validateTimingBaselineCoverage,
} from "../../scripts/e2e-runner-contract.mjs";

function timingBaseline(jobs) {
  return {
    format: timingBaselineFormat,
    jobs: jobs.map(([file, estimatedMilliseconds]) => ({
      file,
      estimatedMilliseconds,
    })),
  };
}

describe("E2E runner contract", () => {
  it("scrubs inherited deployment topology and allows explicit safe values", () => {
    expect(
      createE2EEnvironment(
        {
          NODE_ENV: "production",
          WORKSPACE_ROOTS: "/inherited-unauthorized-root",
          SEDES_BIND_HOST: "0.0.0.0",
          SEDES_TRUSTED_LAN_HOST: "192.168.1.5",
          SEDES_CONVERSATION_RETENTION_MILLISECONDS: "0",
          ALLOWED_TAILSCALE_HOSTS: "unsafe.example.ts.net",
          PLAYWRIGHT_BLOB_OUTPUT_FILE: "/tmp/shared.zip",
          PLAYWRIGHT_HTML_OUTPUT_DIR: "/tmp/shared-report",
          PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: "/tmp/shared-last-run.json",
          KEEP_ME: "yes",
        },
        { SEDES_BIND_HOST: "127.0.0.1", ADDED: "yes" },
      ),
    ).toEqual({
      KEEP_ME: "yes",
      SEDES_BIND_HOST: "127.0.0.1",
      ADDED: "yes",
    });
  });

  it("keeps Playwright arguments intact with the four-lane default", () => {
    expect(parseRunnerArguments(["--grep", "mobile sheet"])).toEqual({
      prebuilt: false,
      laneCount: 4,
      playwrightArguments: ["--grep", "mobile sheet"],
    });
  });

  it("consumes leading runner options and accepts an explicit lane count", () => {
    expect(
      parseRunnerArguments([
        "--prebuilt",
        "--lanes=12",
        "--project",
        "chromium",
      ]),
    ).toEqual({
      prebuilt: true,
      laneCount: 12,
      playwrightArguments: ["--project", "chromium"],
    });
  });

  it("bounds and de-duplicates runner options", () => {
    for (const arguments_ of [
      ["--lanes=0"],
      ["--lanes=13"],
      ["--lanes=two"],
      ["--lanes=2", "--lanes=3"],
      ["--prebuilt", "--prebuilt"],
    ]) {
      expect(() => parseRunnerArguments(arguments_)).toThrow(/e2e_/);
    }
  });

  it("honors the runner delimiter and never consumes Playwright values", () => {
    expect(parseRunnerArguments(["--grep", "--prebuilt"])).toEqual({
      prebuilt: false,
      laneCount: 4,
      playwrightArguments: ["--grep", "--prebuilt"],
    });
    expect(parseRunnerArguments(["--", "--prebuilt", "--lanes=2"])).toEqual({
      prebuilt: false,
      laneCount: 4,
      playwrightArguments: ["--prebuilt", "--lanes=2"],
    });
  });

  it("rejects coordinator-owned and parallel-unsafe Playwright options", () => {
    for (const argument of [
      "--shard=1/2",
      "--workers=2",
      "-j",
      "-j4",
      "--fully-parallel",
      "--reporter=list",
      "--output=elsewhere",
      "--config=other.ts",
      "-c",
      "-cother.ts",
    ]) {
      expect(() => parseRunnerArguments([argument])).toThrow(
        /coordinator_owned/,
      );
    }
    for (const argument of [
      "--ui",
      "--debug",
      "--last-failed",
      "--last-failed-file=shared.json",
      "--max-failures=1",
      "--update-snapshots=all",
      "-x",
      "-u",
      "-uall",
    ]) {
      expect(() => parseRunnerArguments([argument])).toThrow(
        /requires_one_lane/,
      );
      expect(parseRunnerArguments(["--lanes=1", argument]).laneCount).toBe(1);
    }
  });

  it("derives the explicit prebuilt artifact contract", () => {
    expect(prebuiltArtifactPaths("/repo")).toEqual([
      path.join("/repo", "dist/client/index.html"),
      path.join("/repo", "dist/server/index.js"),
      path.join("/repo", "dist/sidecar/manifest.json"),
    ]);
  });

  it("discovers strict matching jobs and counts tests through nested suites", () => {
    expect(
      discoveryJobs({
        suites: [
          {
            file: "b.spec.ts",
            specs: [{ title: "one", file: "b.spec.ts", tests: [{}, {}] }],
            suites: [
              {
                file: "b.spec.ts",
                specs: [{ title: "two", file: "b.spec.ts", tests: [{}] }],
              },
              {
                file: "a.spec.ts",
                specs: [{ title: "three", file: "a.spec.ts", tests: [{}] }],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      { file: "a.spec.ts", testCount: 1 },
      { file: "b.spec.ts", testCount: 3 },
    ]);
    expect(() => discoveryJobs({})).toThrow(/discovery_report_invalid/);
    expect(() =>
      discoveryJobs({
        suites: [{ specs: [{ file: "test.spec.ts", tests: [{}] }] }],
      }),
    ).toThrow(/discovery_file_missing/);
  });

  it("rejects malformed discovery and every unsafe file spelling", () => {
    const reportFor = (file, specs = [{ file, tests: [{}] }]) => ({
      suites: [{ file, specs }],
    });
    for (const file of [
      "../outside.spec.ts",
      "tests/../outside.spec.ts",
      "/absolute.spec.ts",
      "C:\\absolute.spec.ts",
      "C:/absolute.spec.ts",
      " tests/example.spec.ts",
      "tests/example.spec.ts ",
      "tests/example\n.spec.ts",
      "tests//example.spec.ts",
      ".",
    ]) {
      expect(() => discoveryJobs(reportFor(file))).toThrow(
        /discovery_file_invalid/,
      );
    }
    for (const report of [
      { suites: [null] },
      { suites: [{ file: "test.spec.ts" }] },
      { suites: [{ file: "test.spec.ts", specs: "invalid" }] },
      { suites: [{ file: "test.spec.ts", specs: [] }] },
      { suites: [{ file: "test.spec.ts", specs: [], suites: {} }] },
      reportFor("test.spec.ts", [{}]),
      reportFor("test.spec.ts", [{ file: "test.spec.ts", tests: [] }]),
      reportFor("test.spec.ts", [
        { file: "test.spec.ts", tests: ["not-a-test"] },
      ]),
    ]) {
      expect(() => discoveryJobs(report)).toThrow(/discovery_report_invalid/);
    }
    expect(() =>
      discoveryJobs(
        reportFor("test.spec.ts", [{ file: "other.spec.ts", tests: [{}] }]),
      ),
    ).toThrow(/discovery_file_mismatch/);
  });

  it("strictly parses canonical timing baselines and exact spec coverage", () => {
    const baseline = timingBaseline([
      ["a.spec.ts", 10_000],
      ["b.spec.ts", 20_000],
    ]);
    expect(parseTimingBaseline(baseline)).toEqual(baseline);
    expect(
      validateTimingBaselineCoverage(baseline, ["b.spec.ts", "a.spec.ts"]),
    ).toEqual(baseline);

    for (const invalid of [
      { ...baseline, extra: true },
      timingBaseline([]),
      timingBaseline([
        ["b.spec.ts", 20_000],
        ["a.spec.ts", 10_000],
      ]),
      timingBaseline([
        ["a.spec.ts", 10_000],
        ["a.spec.ts", 20_000],
      ]),
      timingBaseline([["../a.spec.ts", 10_000]]),
      timingBaseline([["a.spec.ts", 1_500]]),
      {
        format: timingBaselineFormat,
        jobs: [
          {
            file: "a.spec.ts",
            estimatedMilliseconds: 10_000,
            extra: true,
          },
        ],
      },
    ]) {
      expect(() => parseTimingBaseline(invalid)).toThrow(/timing_baseline/);
    }
    expect(() =>
      validateTimingBaselineCoverage(baseline, ["a.spec.ts", "c.spec.ts"]),
    ).toThrow(/missing=c.spec.ts:obsolete=b.spec.ts/);
  });

  it("creates a minimal rounded baseline only from a complete successful result", () => {
    const result = {
      format: "sedes-e2e-result-v1",
      exitCode: 0,
      matchingJobs: [
        { file: "b.spec.ts", testCount: 2 },
        { file: "a.spec.ts", testCount: 1 },
      ],
      jobs: [
        {
          file: "b.spec.ts",
          exitCode: 0,
          playwrightStarted: true,
          totalMilliseconds: 12_600,
        },
        {
          file: "a.spec.ts",
          exitCode: 0,
          playwrightStarted: true,
          totalMilliseconds: 12_398,
        },
      ],
    };
    expect(
      createTimingBaselineFromResult(result, ["a.spec.ts", "b.spec.ts"]),
    ).toEqual(
      timingBaseline([
        ["a.spec.ts", 12_000],
        ["b.spec.ts", 13_000],
      ]),
    );
    expect(() =>
      createTimingBaselineFromResult({ ...result, exitCode: 1 }, [
        "a.spec.ts",
        "b.spec.ts",
      ]),
    ).toThrow(/result_invalid/);
    expect(() =>
      createTimingBaselineFromResult(
        { ...result, matchingJobs: result.matchingJobs.slice(0, 1) },
        ["a.spec.ts", "b.spec.ts"],
      ),
    ).toThrow(/coverage_invalid/);
    expect(() =>
      createTimingBaselineFromResult(
        { ...result, jobs: [result.jobs[0], result.jobs[0]] },
        ["a.spec.ts", "b.spec.ts"],
      ),
    ).toThrow(/jobs_not_sorted/);
  });

  it("learns only from successful unfiltered jobs with unchanged test counts", () => {
    const run = {
      format: "sedes-e2e-run-v4",
      playwrightArguments: [],
    };
    const result = {
      format: "sedes-e2e-result-v1",
      exitCode: 0,
      completedAt: "2026-08-09T12:00:00.000Z",
      matchingJobs: [{ file: "a.spec.ts", testCount: 3 }],
      jobs: [
        {
          file: "a.spec.ts",
          testCount: 3,
          exitCode: 0,
          playwrightStarted: true,
          totalMilliseconds: 12_000,
        },
      ],
    };
    const matchingJobs = [{ file: "a.spec.ts", testCount: 3 }];
    expect(timingObservationsFromResult(run, result, matchingJobs)).toEqual([
      {
        file: "a.spec.ts",
        durationMilliseconds: 12_000,
        completedAt: Date.parse(result.completedAt),
      },
    ]);
    expect(
      timingObservationsFromResult(
        { ...run, playwrightArguments: ["--grep", "focused"] },
        result,
        matchingJobs,
      ),
    ).toEqual([]);
    expect(
      timingObservationsFromResult(
        run,
        { ...result, exitCode: 1 },
        matchingJobs,
      ),
    ).toEqual([]);
    expect(
      timingObservationsFromResult(run, result, [
        { file: "a.spec.ts", testCount: 4 },
      ]),
    ).toEqual([]);
  });

  it("uses the median of the five newest successful timings without a count floor", () => {
    const job = { file: "tests/slow.spec.ts", testCount: 9 };
    const baseline = timingBaseline([[job.file, 90_000]]);
    const observations = [
      { file: job.file, durationMilliseconds: 900, completedAt: 1 },
      { file: job.file, durationMilliseconds: 500, completedAt: 5 },
      { file: job.file, durationMilliseconds: 100, completedAt: 6 },
      { file: job.file, durationMilliseconds: 300, completedAt: 3 },
      { file: job.file, durationMilliseconds: 200, completedAt: 4 },
      { file: job.file, durationMilliseconds: 400, completedAt: 2 },
      {
        file: "tests/other.spec.ts",
        durationMilliseconds: 99_999,
        completedAt: 99,
      },
    ];
    expect(estimateJobDuration(job, baseline, observations)).toBe(300);
    expect(
      estimateJobDuration(job, baseline, [
        { file: job.file, durationMilliseconds: 100, completedAt: 1 },
        { file: job.file, durationMilliseconds: 300, completedAt: 2 },
      ]),
    ).toBe(200);
  });

  it("prefers local history, then the committed baseline, then test count", () => {
    const baseline = timingBaseline([["known.spec.ts", 20_000]]);
    expect(
      estimateJobDurationWithSource(
        { file: "known.spec.ts", testCount: 20 },
        baseline,
        [],
      ),
    ).toEqual({
      estimatedDurationMilliseconds: 20_000,
      estimateSource: "committed_baseline",
    });
    expect(
      estimateJobDurationWithSource(
        { file: "known.spec.ts", testCount: 20 },
        baseline,
        [
          {
            file: "known.spec.ts",
            durationMilliseconds: 7_000,
            completedAt: 1,
          },
        ],
      ),
    ).toEqual({
      estimatedDurationMilliseconds: 7_000,
      estimateSource: "local_history",
    });
    expect(
      estimateJobDurationWithSource(
        { file: "new.spec.ts", testCount: 2 },
        baseline,
        [],
      ),
    ).toEqual({
      estimatedDurationMilliseconds: 25_000,
      estimateSource: "test_count",
    });
  });

  it("uses deterministic longest-job-first ordering and filename ties", () => {
    const jobs = [
      { file: "tests/z.spec.ts", testCount: 1 },
      { file: "tests/b.spec.ts", testCount: 2 },
      { file: "tests/a.spec.ts", testCount: 2 },
      { file: "tests/hot.spec.ts", testCount: 20 },
    ];
    const observations = [
      {
        file: "tests/hot.spec.ts",
        durationMilliseconds: 25_000,
        completedAt: 1,
      },
    ];
    const baseline = timingBaseline([
      ["placeholder.spec.ts", 1_000],
      ["tests/a.spec.ts", 30_000],
      ["tests/b.spec.ts", 30_000],
      ["tests/z.spec.ts", 15_000],
    ]);
    expect(
      estimateJobDuration(
        { file: "tests/new.spec.ts", testCount: 1 },
        baseline,
        [],
      ),
    ).toBe(15_000);
    expect(sortJobsByEstimatedDuration(jobs, baseline, observations)).toEqual([
      { file: "tests/a.spec.ts", testCount: 2 },
      { file: "tests/b.spec.ts", testCount: 2 },
      { file: "tests/hot.spec.ts", testCount: 20 },
      { file: "tests/z.spec.ts", testCount: 1 },
    ]);
  });

  it("rejects malformed jobs and timing observations", () => {
    const baseline = timingBaseline([["test.spec.ts", 10_000]]);
    expect(() =>
      estimateJobDuration({ file: "../bad", testCount: 1 }, baseline, []),
    ).toThrow(/discovery_file_invalid/);
    expect(() =>
      estimateJobDuration({ file: "test.spec.ts", testCount: 0 }, baseline, []),
    ).toThrow(/discovery_job_invalid/);
    expect(() =>
      estimateJobDuration({ file: "test.spec.ts", testCount: 1 }, baseline, {}),
    ).toThrow(/timing_observations_invalid/);
    expect(() =>
      estimateJobDuration({ file: "test.spec.ts", testCount: 1 }, baseline, [
        { file: "test.spec.ts", durationMilliseconds: -1, completedAt: 1 },
      ]),
    ).toThrow(/timing_observation_invalid/);
  });

  it("caps lanes to matching files and rejects an empty discovery", () => {
    expect(effectiveLaneCount(4, ["one", "two"])).toBe(2);
    expect(effectiveLaneCount(4, ["one", "two", "three", "four"])).toBe(4);
    expect(() => effectiveLaneCount(4, [])).toThrow(/no_matching_tests/);
  });

  it("accepts only a canonical loopback HTTP readiness origin", () => {
    expect(
      validateReadyMessage({
        type: "sedes-e2e-ready",
        origin: "http://127.0.0.1:49152",
      }),
    ).toBe("http://127.0.0.1:49152");

    for (const message of [
      undefined,
      { type: "ready", origin: "http://127.0.0.1:49152" },
      { type: "sedes-e2e-ready", origin: "https://127.0.0.1:49152" },
      { type: "sedes-e2e-ready", origin: "http://localhost:49152" },
      { type: "sedes-e2e-ready", origin: "http://127.0.0.1:49152/path" },
      { type: "sedes-e2e-ready", origin: "http://127.0.0.1" },
    ]) {
      expect(() => validateReadyMessage(message)).toThrow(/readiness/);
    }
  });

  it("maps forwarded termination signals to shell exit status", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGKILL")).toBe(1);
  });
});
