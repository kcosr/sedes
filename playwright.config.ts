import { defineConfig, devices } from "@playwright/test";
import { loadE2ERunContext } from "./tests/e2e/run-context.js";

const runContext = loadE2ERunContext();
const configuredJobTotal = process.env.E2E_JOB_TOTAL;
if (!configuredJobTotal) throw new Error("E2E_JOB_TOTAL is required.");
if (!/^(?:[1-9]|[1-9]\d|[1-9]\d{2})$/.test(configuredJobTotal)) {
  throw new Error(
    "E2E_JOB_TOTAL must be a canonical integer from 1 through 999.",
  );
}
const jobTotal = Number.parseInt(configuredJobTotal, 10);
if (jobTotal === 1 && runContext.jobTotal !== undefined) {
  throw new Error(
    "A single-job E2E run must use its generated run-* directory.",
  );
}
if (
  jobTotal > 1 &&
  (runContext.jobTotal !== jobTotal || runContext.jobIndex === undefined)
) {
  throw new Error(
    "A parallel E2E job must use a matching run-*/jobs/NNN-of-NNN directory.",
  );
}
const configuredJobFile = process.env.E2E_JOB_FILE;
if (
  configuredJobFile &&
  (configuredJobFile !== configuredJobFile.replaceAll("\\", "/") ||
    configuredJobFile.startsWith("/") ||
    configuredJobFile === ".." ||
    configuredJobFile.startsWith("../") ||
    !configuredJobFile.endsWith(".spec.ts"))
) {
  throw new Error("E2E_JOB_FILE must be one relative E2E .spec.ts path.");
}
if (jobTotal > 1 && !configuredJobFile) {
  throw new Error("A parallel E2E job requires E2E_JOB_FILE.");
}
const configuredBaseUrl = process.env.E2E_BASE_URL;
if (!configuredBaseUrl) throw new Error("E2E_BASE_URL is required.");
const parsedBaseUrl = new URL(configuredBaseUrl);
if (
  parsedBaseUrl.protocol !== "http:" ||
  parsedBaseUrl.hostname !== "127.0.0.1" ||
  !parsedBaseUrl.port ||
  parsedBaseUrl.username ||
  parsedBaseUrl.password ||
  parsedBaseUrl.pathname !== "/" ||
  parsedBaseUrl.search ||
  parsedBaseUrl.hash ||
  parsedBaseUrl.origin !== configuredBaseUrl
) {
  throw new Error("E2E_BASE_URL must be a canonical loopback HTTP origin.");
}

export default defineConfig({
  testDir: process.env.SEDES_BROWSER_BENCHMARK === "1" ? "tests/performance" : "tests/e2e",
  testMatch: configuredJobFile ? [configuredJobFile] : undefined,
  outputDir: runContext.playwrightOutputDirectory,
  timeout: 60_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter:
    jobTotal === 1
      ? [
          ["list"],
          [
            "html",
            { outputFolder: runContext.reportDirectory, open: "never" },
          ],
        ]
      : [
          ["list"],
          ["blob", { outputDir: runContext.reportDirectory }],
        ],
  use: {
    baseURL: parsedBaseUrl.origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
