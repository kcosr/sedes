import path from "node:path";
import {
  loadValidatedTimingBaseline,
  timingBaselineRelativePath,
} from "./e2e-timing-baseline.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

try {
  const baseline = await loadValidatedTimingBaseline(repositoryRoot);
  process.stdout.write(
    `[e2e] ${timingBaselineRelativePath} covers ${baseline.jobs.length} spec files\n`,
  );
} catch (error) {
  process.stderr.write(
    `[e2e] timing baseline check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
