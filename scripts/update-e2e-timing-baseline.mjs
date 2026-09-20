import path from "node:path";
import {
  timingBaselineRelativePath,
  updateTimingBaselineFromResult,
} from "./e2e-timing-baseline.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const arguments_ = process.argv.slice(2);

if (arguments_.length !== 1) {
  throw new Error(
    "usage: npm run update:e2e-timing-baseline -- test-results/e2e-runs/run-.../result.json",
  );
}

const resultFilename = path.resolve(process.cwd(), arguments_[0]);
await updateTimingBaselineFromResult(repositoryRoot, resultFilename);
process.stdout.write(
  `[e2e] updated ${timingBaselineRelativePath} from ${path.relative(repositoryRoot, resultFilename)}\n`,
);
