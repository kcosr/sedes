import { fork, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createE2EEnvironment,
  discoveryJobs,
  effectiveLaneCount as calculateEffectiveLaneCount,
  estimateJobDurationWithSource,
  parseRunnerArguments,
  prebuiltArtifactPaths,
  signalExitCode,
  sortJobsByEstimatedDuration,
  timingObservationsFromResult,
  validateReadyMessage,
} from "./e2e-runner-contract.mjs";
import { loadTimingBaseline } from "./e2e-timing-baseline.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const runRoot = path.join(repositoryRoot, "test-results", "e2e-runs");
const playwrightCli = path.join(
  repositoryRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const readinessTimeoutMilliseconds = 120_000;
const gracefulShutdownTimeoutMilliseconds = 20_000;
const forcedShutdownTimeoutMilliseconds = 2_000;
const {
  prebuilt,
  laneCount: requestedLaneCount,
  playwrightArguments,
} = parseRunnerArguments(process.argv.slice(2));

const activeChildren = new Set();
const serverChildren = new Set();
let receivedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal ??= signal;
    terminateActiveChildren(signal);
  });
}

function cleanEnvironment(additions = {}) {
  return createE2EEnvironment(process.env, additions);
}

function signalProcessGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateActiveChildren(signal = "SIGTERM") {
  for (const child of activeChildren) signalProcessGroup(child, signal);
  for (const child of serverChildren) {
    if (!activeChildren.has(child)) signalProcessGroup(child, "SIGTERM");
  }
}

function exitPromise(child) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({ error }));
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function stopChild(child, childExit, signal = "SIGTERM") {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessGroup(child, signal);
  }
  let result = await Promise.race([
    childExit,
    delay(gracefulShutdownTimeoutMilliseconds).then(() => undefined),
  ]);
  if (!result) {
    signalProcessGroup(child, "SIGKILL");
    result = await Promise.race([
      childExit,
      delay(forcedShutdownTimeoutMilliseconds).then(() => undefined),
    ]);
    if (!result) throw new Error("e2e_child_shutdown_deadline_exceeded");
  }
  return result;
}

function spawnNpm(arguments_, environment) {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const commandArguments = npmExecutable
    ? [npmExecutable, ...arguments_]
    : arguments_;
  return spawn(command, commandArguments, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
  });
}

function assertSuccessfulChild(result, code) {
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${code}_terminated:${result.signal}`);
  if (result.code !== 0) throw new Error(`${code}_failed:${result.code}`);
}

async function runBuild() {
  const startedAt = performance.now();
  const child = spawnNpm(["run", "build"], cleanEnvironment());
  activeChildren.add(child);
  const result = await exitPromise(child);
  activeChildren.delete(child);
  process.stdout.write(
    `[e2e] build ${(performance.now() - startedAt).toFixed(0)}ms\n`,
  );
  if (receivedSignal) return;
  assertSuccessfulChild(result, "e2e_build");
}

async function assertPrebuiltArtifacts() {
  const missing = [];
  for (const filename of prebuiltArtifactPaths(repositoryRoot)) {
    try {
      await access(filename);
    } catch {
      missing.push(path.relative(repositoryRoot, filename));
    }
  }
  if (missing.length > 0) {
    throw new Error(`e2e_prebuilt_artifacts_missing:${missing.join(",")}`);
  }
}

async function createContextDirectories(runDirectory) {
  const context = {
    runDirectory,
    stateDirectory: path.join(runDirectory, "state"),
    workspacesDirectory: path.join(runDirectory, "workspaces"),
    screenshotsDirectory: path.join(runDirectory, "screenshots"),
    playwrightOutputDirectory: path.join(runDirectory, "playwright"),
    reportDirectory: path.join(runDirectory, "report"),
    logsDirectory: path.join(runDirectory, "logs"),
  };
  await Promise.all(
    Object.values(context)
      .slice(1)
      .map((directory) => mkdir(directory, { recursive: true })),
  );
  return context;
}

async function allocateInvocationRoot() {
  await mkdir(runRoot, { recursive: true });
  const runDirectory = await mkdtemp(path.join(runRoot, "run-"));
  const context = await createContextDirectories(runDirectory);
  const invocation = {
    ...context,
    blobReportDirectory: path.join(runDirectory, "blob-report"),
    jobsDirectory: path.join(runDirectory, "jobs"),
  };
  await Promise.all([
    mkdir(invocation.blobReportDirectory, { recursive: true }),
    mkdir(invocation.jobsDirectory, { recursive: true }),
  ]);
  return invocation;
}

function paddedJob(value) {
  return String(value).padStart(3, "0");
}

async function allocateJobs(invocation, scheduledJobs, laneCount) {
  if (laneCount === 1) {
    const attributableJob =
      scheduledJobs.length === 1 ? scheduledJobs[0] : undefined;
    return [
      {
        ...invocation,
        ...attributableJob,
        jobIndex: 1,
        jobTotal: 1,
        label: "001-of-001",
        file: attributableJob?.file,
      },
    ];
  }
  if (scheduledJobs.length > 999) throw new Error("e2e_job_count_exceeded");
  return Promise.all(
    scheduledJobs.map(async (scheduledJob, offset) => {
      const jobIndex = offset + 1;
      const label = `${paddedJob(jobIndex)}-of-${paddedJob(scheduledJobs.length)}`;
      const jobDirectory = path.join(invocation.jobsDirectory, label);
      await mkdir(jobDirectory, { recursive: false });
      return {
        ...(await createContextDirectories(jobDirectory)),
        ...scheduledJob,
        jobIndex,
        jobTotal: scheduledJobs.length,
        label,
      };
    }),
  );
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}

function basePlaywrightEnvironment(runDirectory, jobTotal, baseUrl, jobFile) {
  return cleanEnvironment({
    E2E_BASE_URL: baseUrl,
    E2E_RUN_DIR: runDirectory,
    E2E_JOB_TOTAL: String(jobTotal),
    ...(jobFile ? { E2E_JOB_FILE: jobFile } : {}),
  });
}

async function discoverJobs(invocation) {
  const child = spawn(
    process.execPath,
    [
      playwrightCli,
      "test",
      ...playwrightArguments,
      "--list",
      "--reporter=json",
    ],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: basePlaywrightEnvironment(
        invocation.runDirectory,
        1,
        "http://127.0.0.1:1",
      ),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 16 * 1024 * 1024) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });
  const result = await exitPromise(child);
  activeChildren.delete(child);
  if (receivedSignal) return [];
  try {
    assertSuccessfulChild(result, "e2e_discovery");
  } catch (error) {
    if (stderr) process.stderr.write(stderr);
    throw error;
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("e2e_discovery_report_invalid");
  }
  return discoveryJobs(report);
}

async function loadSuccessfulTimingObservations(matchingJobs) {
  let entries;
  try {
    entries = await readdir(runRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const completedRuns = [];
  const candidateEntries = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.startsWith("run-") &&
      entry.name !== "run-",
  );
  for (const entry of candidateEntries) {
    try {
      const directory = path.join(runRoot, entry.name);
      const [run, result] = await Promise.all(
        ["run.json", "result.json"].map(async (filename) =>
          JSON.parse(await readFile(path.join(directory, filename), "utf8")),
        ),
      );
      const observations = timingObservationsFromResult(
        run,
        result,
        matchingJobs,
      );
      if (observations.length > 0) {
        completedRuns.push({
          completedAt: observations[0].completedAt,
          observations,
        });
      }
    } catch {
      // Incomplete, obsolete, and concurrently active runs are not history.
    }
  }

  return completedRuns
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, 32)
    .flatMap(({ observations }) => observations);
}

function scheduleJobs(matchingJobs, timingBaseline, timingObservations) {
  return sortJobsByEstimatedDuration(
    matchingJobs,
    timingBaseline,
    timingObservations,
  ).map((job, offset) => ({
    ...job,
    queuePosition: offset + 1,
    ...estimateJobDurationWithSource(job, timingBaseline, timingObservations),
  }));
}

function teeStream(source, destination, logStream) {
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    destination.write(chunk);
    logStream.write(chunk);
  });
}

function waitForReadiness(child, childExit) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.on("message", (message) => {
        try {
          resolve(validateReadyMessage(message));
        } catch (error) {
          reject(error);
        }
      });
    }),
    childExit.then((result) => {
      if (result.error) throw result.error;
      throw new Error(
        `e2e_server_exited_before_ready:${result.code ?? result.signal ?? "unknown"}`,
      );
    }),
    delay(readinessTimeoutMilliseconds).then(() => {
      throw new Error("e2e_server_readiness_timeout");
    }),
  ]);
}

async function startServer(job, laneNumber, onInfrastructureFailure) {
  const startedAt = performance.now();
  const stdoutLog = createWriteStream(
    path.join(job.logsDirectory, "server.stdout.log"),
    { flags: "wx" },
  );
  const stderrLog = createWriteStream(
    path.join(job.logsDirectory, "server.stderr.log"),
    { flags: "wx" },
  );
  const child = fork(
    path.join(repositoryRoot, "tests/e2e/test-server.ts"),
    [],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: cleanEnvironment({
        E2E_RUN_DIR: job.runDirectory,
        E2E_LISTEN_PORT: "0",
        APP_STATE_DIR: job.stateDirectory,
        SEDES_CONFIG_FILE: path.join(
          repositoryRoot,
          "config",
          "server.example.json",
        ),
        SEDES_BIND_HOST: "127.0.0.1",
        PORT: "4784",
      }),
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const childExit = exitPromise(child);
  teeStream(child.stdout, process.stdout, stdoutLog);
  teeStream(child.stderr, process.stderr, stderrLog);
  childExit.finally(() => {
    stdoutLog.end();
    stderrLog.end();
  });
  serverChildren.add(child);
  activeChildren.add(child);
  try {
    const origin = await waitForReadiness(child, childExit);
    activeChildren.delete(child);
    process.stdout.write(
      `[e2e] lane ${laneNumber} job ${job.label} server ${origin} ` +
        `${(performance.now() - startedAt).toFixed(0)}ms\n`,
    );
    return { child, childExit, origin };
  } catch (error) {
    onInfrastructureFailure(
      error instanceof Error ? error.message : String(error),
    );
    await stopChild(child, childExit);
    activeChildren.delete(child);
    serverChildren.delete(child);
    throw error;
  }
}

function startPlaywright(job, origin) {
  const stdoutLog = createWriteStream(
    path.join(job.logsDirectory, "playwright.stdout.log"),
    { flags: "wx" },
  );
  const stderrLog = createWriteStream(
    path.join(job.logsDirectory, "playwright.stderr.log"),
    { flags: "wx" },
  );
  const child = spawn(
    process.execPath,
    [playwrightCli, "test", ...playwrightArguments],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: basePlaywrightEnvironment(
        job.runDirectory,
        job.jobTotal,
        origin,
        job.file,
      ),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childExit = exitPromise(child);
  teeStream(child.stdout, process.stdout, stdoutLog);
  teeStream(child.stderr, process.stderr, stderrLog);
  childExit.finally(() => {
    stdoutLog.end();
    stderrLog.end();
  });
  activeChildren.add(child);
  return { child, childExit };
}

function childExitCode(result) {
  if (result?.error) return 1;
  if (result?.signal)
    return receivedSignal ? signalExitCode(receivedSignal) : 1;
  return result?.code ?? 1;
}

function gracefulShutdownFailure(result) {
  if (result?.error) return result.error.message;
  if (result?.signal) return `terminated:${result.signal}`;
  if (result?.code !== 0) return `exit:${result?.code ?? "unknown"}`;
}

async function runJob(job, laneNumber, onInfrastructureFailure) {
  const startedAt = performance.now();
  const result = {
    label: job.label,
    jobIndex: job.jobIndex,
    jobTotal: job.jobTotal,
    file: job.file,
    testCount: job.testCount,
    queuePosition: job.queuePosition,
    estimatedDurationMilliseconds: job.estimatedDurationMilliseconds,
    estimateSource: job.estimateSource,
    laneNumber,
    exitCode: 1,
    playwrightStarted: false,
  };
  let server;
  let playwright;
  try {
    process.stdout.write(
      `[e2e] lane ${laneNumber} starting ${job.file ?? "serial suite"}\n`,
    );
    server = await startServer(job, laneNumber, onInfrastructureFailure);
    if (receivedSignal) {
      result.exitCode = signalExitCode(receivedSignal);
      return result;
    }
    playwright = startPlaywright(job, server.origin);
    result.playwrightStarted = true;
    const observed = await Promise.race([
      playwright.childExit.then((outcome) => ({
        source: "playwright",
        outcome,
      })),
      server.childExit.then((outcome) => ({ source: "server", outcome })),
    ]);
    if (observed.source === "server") {
      result.infrastructureFailure =
        observed.outcome.error?.message ??
        observed.outcome.code ??
        observed.outcome.signal ??
        "unknown";
      onInfrastructureFailure(
        `server_exited:${job.label}:${result.infrastructureFailure}`,
      );
      await stopChild(playwright.child, playwright.childExit);
      result.exitCode = 1;
    } else {
      result.exitCode = childExitCode(observed.outcome);
    }
    return result;
  } catch (error) {
    result.failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    result.infrastructureFailure ??= result.failure;
    onInfrastructureFailure(`job_failed:${job.label}:${result.failure}`);
    result.exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
    return result;
  } finally {
    if (playwright) {
      if (playwright.child.exitCode === null) {
        await stopChild(playwright.child, playwright.childExit);
      }
      activeChildren.delete(playwright.child);
    }
    if (server) {
      const stopResult = await stopChild(server.child, server.childExit);
      serverChildren.delete(server.child);
      const shutdownFailure = receivedSignal
        ? undefined
        : gracefulShutdownFailure(stopResult);
      if (shutdownFailure) {
        result.serverShutdownFailure = shutdownFailure;
        result.infrastructureFailure ??= `server_shutdown:${shutdownFailure}`;
        onInfrastructureFailure(
          `server_shutdown:${job.label}:${shutdownFailure}`,
        );
        result.exitCode = 1;
      }
    }
    result.totalMilliseconds = Math.round(performance.now() - startedAt);
    await writeJson(path.join(job.runDirectory, "job-result.json"), {
      ...result,
      completedAt: new Date().toISOString(),
    });
    process.stdout.write(
      `[e2e] lane ${laneNumber} finished ${job.file ?? "serial suite"} ` +
        `${result.totalMilliseconds}ms exit ${result.exitCode}\n`,
    );
  }
}

async function runJobPool(jobs, laneCount) {
  const results = new Array(jobs.length);
  let nextJobIndex = 0;
  let infrastructureAbort;
  const abortInfrastructure = (reason) => {
    if (infrastructureAbort) return;
    infrastructureAbort = reason;
    process.stderr.write(`[e2e] aborting job pool: ${reason}\n`);
    terminateActiveChildren();
  };
  const worker = async (laneOffset) => {
    while (!receivedSignal && !infrastructureAbort) {
      const jobOffset = nextJobIndex;
      nextJobIndex += 1;
      const job = jobs[jobOffset];
      if (!job) return;
      results[jobOffset] = await runJob(
        job,
        laneOffset + 1,
        abortInfrastructure,
      );
    }
  };
  await Promise.all(
    Array.from({ length: laneCount }, (_, laneOffset) => worker(laneOffset)),
  );
  for (let offset = 0; offset < jobs.length; offset += 1) {
    if (results[offset]) continue;
    const job = jobs[offset];
    const skipped = {
      label: job.label,
      jobIndex: job.jobIndex,
      jobTotal: job.jobTotal,
      file: job.file,
      testCount: job.testCount,
      queuePosition: job.queuePosition,
      estimatedDurationMilliseconds: job.estimatedDurationMilliseconds,
      estimateSource: job.estimateSource,
      exitCode: receivedSignal ? signalExitCode(receivedSignal) : 1,
      playwrightStarted: false,
      notStarted: true,
      ...(infrastructureAbort
        ? { aborted: true, infrastructureFailure: infrastructureAbort }
        : {}),
    };
    results[offset] = skipped;
    await writeJson(path.join(job.runDirectory, "job-result.json"), {
      ...skipped,
      completedAt: new Date().toISOString(),
    });
  }
  return results;
}

async function collectBlobReports(invocation, jobs, jobResults) {
  const collected = [];
  for (const job of jobs) {
    const jobResult = jobResults[job.jobIndex - 1];
    if (!jobResult?.playwrightStarted) continue;
    const entries = (await readdir(job.reportDirectory)).filter((entry) =>
      entry.endsWith(".zip"),
    );
    if (entries.length !== 1) {
      throw new Error(`e2e_blob_report_missing:${job.label}`);
    }
    const destination = path.join(
      invocation.blobReportDirectory,
      `report-${job.label}.zip`,
    );
    await copyFile(path.join(job.reportDirectory, entries[0]), destination);
    collected.push(destination);
  }
  return collected;
}

async function mergeReports(invocation) {
  const log = createWriteStream(
    path.join(invocation.logsDirectory, "report-merge.log"),
    { flags: "wx" },
  );
  const child = spawn(
    process.execPath,
    [
      playwrightCli,
      "merge-reports",
      invocation.blobReportDirectory,
      "--reporter=html",
    ],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: cleanEnvironment({
        PLAYWRIGHT_HTML_OPEN: "never",
        PLAYWRIGHT_HTML_OUTPUT_DIR: invocation.reportDirectory,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childExit = exitPromise(child);
  teeStream(child.stdout, process.stdout, log);
  teeStream(child.stderr, process.stderr, log);
  childExit.finally(() => log.end());
  activeChildren.add(child);
  const result = await childExit;
  activeChildren.delete(child);
  if (receivedSignal) return;
  assertSuccessfulChild(result, "e2e_report_merge");
}

async function runInvocation() {
  const totalStartedAt = performance.now();
  const timingBaseline = await loadTimingBaseline(repositoryRoot);
  if (prebuilt) await assertPrebuiltArtifacts();
  else await runBuild();
  if (receivedSignal) return signalExitCode(receivedSignal);

  const invocation = await allocateInvocationRoot();
  process.stdout.write(`[e2e] run directory ${invocation.runDirectory}\n`);
  await writeJson(path.join(invocation.runDirectory, "run.json"), {
    format: "sedes-e2e-run-v4",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    requestedLaneCount,
    playwrightArguments,
  });

  let exitCode = 1;
  let failure;
  let matchingJobs = [];
  let scheduledJobs = [];
  let timingObservationCount = 0;
  let timingEstimateSourceCounts = {};
  let effectiveLaneCount;
  let jobs = [];
  let jobResults = [];
  try {
    matchingJobs = await discoverJobs(invocation);
    if (receivedSignal) {
      exitCode = signalExitCode(receivedSignal);
      return exitCode;
    }
    effectiveLaneCount = calculateEffectiveLaneCount(
      requestedLaneCount,
      matchingJobs,
    );
    const timingObservations =
      await loadSuccessfulTimingObservations(matchingJobs);
    timingObservationCount = timingObservations.length;
    scheduledJobs = scheduleJobs(
      matchingJobs,
      timingBaseline,
      timingObservations,
    );
    timingEstimateSourceCounts = Object.fromEntries(
      [...new Set(scheduledJobs.map(({ estimateSource }) => estimateSource))]
        .sort()
        .map((source) => [
          source,
          scheduledJobs.filter(
            ({ estimateSource }) => estimateSource === source,
          ).length,
        ]),
    );
    jobs = await allocateJobs(invocation, scheduledJobs, effectiveLaneCount);
    process.stdout.write(
      `[e2e] ${matchingJobs.length} matching files, ` +
        `${effectiveLaneCount} ${effectiveLaneCount === 1 ? "lane" : "parallel lanes"}, ` +
        `${jobs.length} job${jobs.length === 1 ? "" : "s"}, ` +
        `${timingObservationCount} local timing observations, ` +
        `${timingBaseline.jobs.length} committed timing estimates\n`,
    );
    jobResults = await runJobPool(jobs, effectiveLaneCount);
    exitCode = jobResults.some((result) => result.exitCode !== 0) ? 1 : 0;

    if (!receivedSignal && jobs.length > 1) {
      const blobReports = await collectBlobReports(
        invocation,
        jobs,
        jobResults,
      );
      if (blobReports.length > 0) await mergeReports(invocation);
    }
    if (receivedSignal) exitCode = signalExitCode(receivedSignal);
    return exitCode;
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[e2e] ${failure}\n`);
    exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
    return exitCode;
  } finally {
    await writeJson(path.join(invocation.runDirectory, "result.json"), {
      format: "sedes-e2e-result-v1",
      exitCode,
      requestedLaneCount,
      effectiveLaneCount,
      matchingJobs,
      scheduledJobs,
      timingObservationCount,
      timingEstimateSourceCounts,
      jobs: jobResults,
      failure,
      totalMilliseconds: Math.round(performance.now() - totalStartedAt),
      completedAt: new Date().toISOString(),
    });
    process.stdout.write(
      `[e2e] total ${(performance.now() - totalStartedAt).toFixed(0)}ms\n`,
    );
  }
}

try {
  process.exitCode = await runInvocation();
} catch (error) {
  for (const child of activeChildren) signalProcessGroup(child, "SIGTERM");
  for (const child of serverChildren) signalProcessGroup(child, "SIGTERM");
  process.stderr.write(
    `[e2e] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
}
