#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelog } from "./changelog.mjs";

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { entries, baseline } = checkChangelog(root);
  console.log(`Changelog is valid (${entries.length - 1} releases). ${baseline
    ? `Released notes match local baseline ${baseline.slice(0, 12)}.`
    : "Released-note comparison skipped: no local Git baseline."}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
