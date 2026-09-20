import path from "node:path";

export const requiredPrebuiltArtifacts = [
  "dist/client/index.html",
  "dist/server/index.js",
  "dist/sidecar/manifest.json",
];

export const timingBaselineFormat = "sedes-e2e-timing-baseline-v1";

const scrubbedEnvironmentVariables = [
  "NODE_ENV",
  "WORKSPACE_ROOTS",
  "SEDES_BIND_HOST",
  "SEDES_TRUSTED_LAN_HOST",
  "SEDES_CONVERSATION_RETENTION_MILLISECONDS",
  "ALLOWED_TAILSCALE_HOSTS",
  "PLAYWRIGHT_BLOB_OUTPUT_FILE",
  "PLAYWRIGHT_BLOB_OUTPUT_DIR",
  "PLAYWRIGHT_BLOB_OUTPUT_NAME",
  "PLAYWRIGHT_JSON_OUTPUT_FILE",
  "PLAYWRIGHT_JSON_OUTPUT_DIR",
  "PLAYWRIGHT_JSON_OUTPUT_NAME",
  "PLAYWRIGHT_JUNIT_OUTPUT_FILE",
  "PLAYWRIGHT_JUNIT_OUTPUT_DIR",
  "PLAYWRIGHT_JUNIT_OUTPUT_NAME",
  "PLAYWRIGHT_HTML_OUTPUT_DIR",
  "PLAYWRIGHT_HTML_REPORT",
  "PLAYWRIGHT_LAST_RUN_OUTPUT_FILE",
  "PWTEST_BLOB_DO_NOT_REMOVE",
];

export function createE2EEnvironment(inherited, additions = {}) {
  const environment = { ...inherited };
  for (const variable of scrubbedEnvironmentVariables) {
    delete environment[variable];
  }
  return { ...environment, ...additions };
}

export function parseRunnerArguments(arguments_) {
  const playwrightArguments = [];
  let prebuilt = false;
  let requestedLaneCount;
  let parsingRunnerOptions = true;
  for (const argument of arguments_) {
    if (parsingRunnerOptions && argument === "--") {
      parsingRunnerOptions = false;
      continue;
    }
    if (parsingRunnerOptions && argument === "--prebuilt") {
      if (prebuilt) throw new Error("e2e_prebuilt_option_repeated");
      prebuilt = true;
      continue;
    }
    if (parsingRunnerOptions && argument.startsWith("--lanes=")) {
      if (requestedLaneCount !== undefined) {
        throw new Error("e2e_lanes_option_repeated");
      }
      const value = argument.slice("--lanes=".length);
      if (!/^(?:[1-9]|1[0-2])$/.test(value)) {
        throw new Error("e2e_lanes_option_invalid");
      }
      requestedLaneCount = Number(value);
      continue;
    }
    parsingRunnerOptions = false;
    playwrightArguments.push(argument);
  }
  const laneCount = requestedLaneCount ?? 4;
  assertPlaywrightArguments(playwrightArguments, laneCount);
  return { prebuilt, laneCount, playwrightArguments };
}

function assertPlaywrightArguments(arguments_, laneCount) {
  const coordinatorOwned = [
    "--shard",
    "--workers",
    "-j",
    "--fully-parallel",
    "--reporter",
    "--output",
    "--config",
    "-c",
  ];
  for (const argument of arguments_) {
    if (
      coordinatorOwned.some(
        (option) => argument === option || argument.startsWith(`${option}=`),
      ) ||
      argument.startsWith("-j") ||
      argument.startsWith("-c")
    ) {
      throw new Error(`e2e_playwright_option_coordinator_owned:${argument}`);
    }
  }
  if (laneCount === 1) return;
  const serialOnly = [
    "--ui",
    "--ui-host",
    "--ui-port",
    "--update-snapshots",
    "--update-source-method",
    "--last-failed",
    "--last-failed-file",
    "--max-failures",
    "-x",
    "--debug",
    "--list",
    "-u",
  ];
  for (const argument of arguments_) {
    if (
      serialOnly.some(
        (option) => argument === option || argument.startsWith(`${option}=`),
      ) ||
      argument.startsWith("-u")
    ) {
      throw new Error(`e2e_playwright_option_requires_one_lane:${argument}`);
    }
  }
}

export function prebuiltArtifactPaths(repositoryRoot) {
  return requiredPrebuiltArtifacts.map((relativePath) =>
    path.join(repositoryRoot, relativePath),
  );
}

function discoveryFile(file) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.trim() !== file ||
    file.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(file) ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    file === "." ||
    file === ".." ||
    file.startsWith("../") ||
    path.posix.normalize(file) !== file
  ) {
    throw new Error("e2e_discovery_file_invalid");
  }
  return file;
}

function compareFiles(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export function discoveryJobs(report) {
  if (!Array.isArray(report?.suites)) {
    throw new Error("e2e_discovery_report_invalid");
  }
  const testCounts = new Map();
  const visitSuite = (suite) => {
    if (!suite || typeof suite !== "object" || Array.isArray(suite)) {
      throw new Error("e2e_discovery_report_invalid");
    }
    if (!Array.isArray(suite.specs)) {
      throw new Error("e2e_discovery_report_invalid");
    }
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) {
      throw new Error("e2e_discovery_report_invalid");
    }
    if (typeof suite.file !== "string" || suite.file.length === 0) {
      throw new Error("e2e_discovery_file_missing");
    }
    const file = discoveryFile(suite.file);
    if (suite.specs.length === 0 && !suite.suites?.length) {
      throw new Error("e2e_discovery_report_invalid");
    }
    if (suite.specs.length > 0) {
      let testCount = 0;
      for (const spec of suite.specs) {
        if (
          !spec ||
          typeof spec !== "object" ||
          Array.isArray(spec) ||
          !Array.isArray(spec.tests) ||
          spec.tests.length === 0 ||
          spec.tests.some(
            (test) => !test || typeof test !== "object" || Array.isArray(test),
          )
        ) {
          throw new Error("e2e_discovery_report_invalid");
        }
        if (discoveryFile(spec.file) !== file) {
          throw new Error("e2e_discovery_file_mismatch");
        }
        testCount += spec.tests.length;
      }
      testCounts.set(file, (testCounts.get(file) ?? 0) + testCount);
    }
    suite.suites?.forEach(visitSuite);
  };
  report.suites.forEach(visitSuite);
  return [...testCounts]
    .sort(([left], [right]) => compareFiles(left, right))
    .map(([file, testCount]) => ({ file, testCount }));
}

function assertDiscoveryJob(job) {
  if (
    !job ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    !Number.isSafeInteger(job.testCount) ||
    job.testCount < 1
  ) {
    throw new Error("e2e_discovery_job_invalid");
  }
  return { file: discoveryFile(job.file), testCount: job.testCount };
}

function assertTimingObservation(observation) {
  if (
    !observation ||
    typeof observation !== "object" ||
    Array.isArray(observation) ||
    !Number.isFinite(observation.durationMilliseconds) ||
    observation.durationMilliseconds < 0 ||
    !Number.isFinite(observation.completedAt) ||
    observation.completedAt < 0
  ) {
    throw new Error("e2e_job_timing_observation_invalid");
  }
  return {
    file: discoveryFile(observation.file),
    durationMilliseconds: observation.durationMilliseconds,
    completedAt: observation.completedAt,
  };
}

export function timingObservationsFromResult(run, result, matchingJobs) {
  if (!Array.isArray(matchingJobs)) {
    throw new Error("e2e_discovery_jobs_invalid");
  }
  const currentTestCounts = new Map();
  for (const matchingJob of matchingJobs) {
    const job = assertDiscoveryJob(matchingJob);
    if (currentTestCounts.has(job.file)) {
      throw new Error("e2e_discovery_jobs_duplicate");
    }
    currentTestCounts.set(job.file, job.testCount);
  }
  if (
    run?.format !== "sedes-e2e-run-v4" ||
    !Array.isArray(run.playwrightArguments) ||
    run.playwrightArguments.length !== 0 ||
    result?.format !== "sedes-e2e-result-v1" ||
    result.exitCode !== 0 ||
    !Array.isArray(result.matchingJobs) ||
    !Array.isArray(result.jobs)
  ) {
    return [];
  }
  const completedAt = Date.parse(result.completedAt);
  if (!Number.isFinite(completedAt)) return [];

  const recordedTestCounts = new Map();
  for (const matchingJob of result.matchingJobs) {
    const job = assertDiscoveryJob(matchingJob);
    if (recordedTestCounts.has(job.file)) {
      throw new Error("e2e_timing_result_jobs_duplicate");
    }
    recordedTestCounts.set(job.file, job.testCount);
  }
  return result.jobs.flatMap((job) => {
    if (
      job?.exitCode !== 0 ||
      job.playwrightStarted !== true ||
      typeof job.file !== "string" ||
      !Number.isSafeInteger(job.testCount) ||
      !Number.isFinite(job.totalMilliseconds) ||
      job.totalMilliseconds < 0
    ) {
      return [];
    }
    const currentTestCount = currentTestCounts.get(job.file);
    if (
      currentTestCount === undefined ||
      job.testCount !== currentTestCount ||
      recordedTestCounts.get(job.file) !== currentTestCount
    ) {
      return [];
    }
    return [
      {
        file: discoveryFile(job.file),
        durationMilliseconds: job.totalMilliseconds,
        completedAt,
      },
    ];
  });
}

export function parseTimingBaseline(value) {
  if (
    !hasExactKeys(value, ["format", "jobs"]) ||
    value.format !== timingBaselineFormat ||
    !Array.isArray(value.jobs) ||
    value.jobs.length === 0
  ) {
    throw new Error("e2e_timing_baseline_invalid");
  }
  let previousFile;
  const jobs = value.jobs.map((job) => {
    if (
      !hasExactKeys(job, ["file", "estimatedMilliseconds"]) ||
      !Number.isSafeInteger(job.estimatedMilliseconds) ||
      job.estimatedMilliseconds < 1_000 ||
      job.estimatedMilliseconds > 3_600_000 ||
      job.estimatedMilliseconds % 1_000 !== 0
    ) {
      throw new Error("e2e_timing_baseline_job_invalid");
    }
    let file;
    try {
      file = discoveryFile(job.file);
    } catch (error) {
      throw new Error("e2e_timing_baseline_job_invalid", { cause: error });
    }
    if (previousFile !== undefined && compareFiles(previousFile, file) >= 0) {
      throw new Error("e2e_timing_baseline_jobs_not_sorted");
    }
    previousFile = file;
    return { file, estimatedMilliseconds: job.estimatedMilliseconds };
  });
  return { format: timingBaselineFormat, jobs };
}

export function validateTimingBaselineCoverage(value, specFiles) {
  const baseline = parseTimingBaseline(value);
  if (!Array.isArray(specFiles) || specFiles.length === 0) {
    throw new Error("e2e_timing_baseline_spec_files_invalid");
  }
  const expectedFiles = [...new Set(specFiles.map(discoveryFile))].sort(
    compareFiles,
  );
  if (expectedFiles.length !== specFiles.length) {
    throw new Error("e2e_timing_baseline_spec_files_invalid");
  }
  const baselineFiles = baseline.jobs.map(({ file }) => file);
  const expected = new Set(expectedFiles);
  const actual = new Set(baselineFiles);
  const missing = expectedFiles.filter((file) => !actual.has(file));
  const obsolete = baselineFiles.filter((file) => !expected.has(file));
  if (missing.length > 0 || obsolete.length > 0) {
    throw new Error(
      `e2e_timing_baseline_coverage_invalid:missing=${missing.join(",")}:obsolete=${obsolete.join(",")}`,
    );
  }
  return baseline;
}

export function createTimingBaselineFromResult(result, specFiles) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.format !== "sedes-e2e-result-v1" ||
    result.exitCode !== 0 ||
    !Array.isArray(result.matchingJobs) ||
    !Array.isArray(result.jobs) ||
    result.jobs.length === 0
  ) {
    throw new Error("e2e_timing_baseline_result_invalid");
  }
  const matchingFiles = result.matchingJobs
    .map(assertDiscoveryJob)
    .map(({ file }) => file);
  validateTimingBaselineCoverage(
    {
      format: timingBaselineFormat,
      jobs: [...matchingFiles]
        .sort(compareFiles)
        .map((file) => ({ file, estimatedMilliseconds: 1_000 })),
    },
    specFiles,
  );
  const jobs = result.jobs
    .map((job) => {
      if (
        !job ||
        typeof job !== "object" ||
        Array.isArray(job) ||
        job.exitCode !== 0 ||
        job.playwrightStarted !== true ||
        !Number.isFinite(job.totalMilliseconds) ||
        job.totalMilliseconds <= 0
      ) {
        throw new Error("e2e_timing_baseline_result_job_invalid");
      }
      return {
        file: discoveryFile(job.file),
        estimatedMilliseconds: Math.max(
          1_000,
          Math.round(job.totalMilliseconds / 1_000) * 1_000,
        ),
      };
    })
    .sort((left, right) => compareFiles(left.file, right.file));
  return validateTimingBaselineCoverage(
    { format: timingBaselineFormat, jobs },
    specFiles,
  );
}

export function serializeTimingBaseline(value) {
  const baseline = parseTimingBaseline(value);
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function estimateJobDuration(
  job,
  timingBaseline,
  successfulTimingObservations,
) {
  return estimateJobDurationWithSource(
    job,
    timingBaseline,
    successfulTimingObservations,
  ).estimatedDurationMilliseconds;
}

export function estimateJobDurationWithSource(
  job,
  timingBaseline,
  successfulTimingObservations,
) {
  const validatedJob = assertDiscoveryJob(job);
  const baseline = parseTimingBaseline(timingBaseline);
  if (!Array.isArray(successfulTimingObservations)) {
    throw new Error("e2e_job_timing_observations_invalid");
  }
  const durations = successfulTimingObservations
    .map(assertTimingObservation)
    .filter((observation) => observation.file === validatedJob.file)
    .sort(
      (left, right) =>
        right.completedAt - left.completedAt ||
        left.durationMilliseconds - right.durationMilliseconds,
    )
    .slice(0, 5)
    .map(({ durationMilliseconds }) => durationMilliseconds)
    .sort((left, right) => left - right);
  if (durations.length > 0) {
    const midpoint = Math.floor(durations.length / 2);
    return {
      estimatedDurationMilliseconds:
        durations.length % 2 === 1
          ? durations[midpoint]
          : (durations[midpoint - 1] + durations[midpoint]) / 2,
      estimateSource: "local_history",
    };
  }
  const repositoryEstimate = baseline.jobs.find(
    ({ file }) => file === validatedJob.file,
  )?.estimatedMilliseconds;
  if (repositoryEstimate !== undefined) {
    return {
      estimatedDurationMilliseconds: repositoryEstimate,
      estimateSource: "committed_baseline",
    };
  }
  return {
    estimatedDurationMilliseconds: 5_000 + 10_000 * validatedJob.testCount,
    estimateSource: "test_count",
  };
}

export function sortJobsByEstimatedDuration(
  jobs,
  timingBaseline,
  successfulTimingObservations,
) {
  if (!Array.isArray(jobs)) {
    throw new Error("e2e_discovery_jobs_invalid");
  }
  const estimates = jobs.map((job) => {
    const validatedJob = assertDiscoveryJob(job);
    return {
      job: validatedJob,
      estimate: estimateJobDuration(
        validatedJob,
        timingBaseline,
        successfulTimingObservations,
      ),
    };
  });
  return estimates
    .sort(
      (left, right) =>
        right.estimate - left.estimate ||
        right.job.testCount - left.job.testCount ||
        compareFiles(left.job.file, right.job.file),
    )
    .map(({ job }) => job);
}

export function effectiveLaneCount(requestedLaneCount, matchingFiles) {
  if (!Array.isArray(matchingFiles) || matchingFiles.length === 0) {
    throw new Error("e2e_no_matching_tests");
  }
  return Math.min(requestedLaneCount, matchingFiles.length);
}

export function validateReadyMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    message.type !== "sedes-e2e-ready" ||
    typeof message.origin !== "string"
  ) {
    throw new Error("e2e_server_readiness_message_invalid");
  }

  let origin;
  try {
    origin = new URL(message.origin);
  } catch {
    throw new Error("e2e_server_readiness_origin_invalid");
  }
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.origin !== message.origin
  ) {
    throw new Error("e2e_server_readiness_origin_invalid");
  }
  const port = Number(origin.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("e2e_server_readiness_origin_invalid");
  }
  return origin.origin;
}

export function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
