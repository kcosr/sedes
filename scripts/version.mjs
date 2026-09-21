#!/usr/bin/env node
// Keeps every version-bearing file in the repository in agreement.
//
//   node scripts/version.mjs set X.Y.Z   rewrite all of them to X.Y.Z
//   node scripts/version.mjs check       exit 1 if any disagree
//
// The Android project derives versionName and versionCode from package.json
// at build time, so it is not listed here.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifests = [
  "package.json",
  "electron/package.json",
  "packages/electron-client-credentials/package.json",
  "packages/electron-connection-runtime/package.json",
  "packages/electron-local-server-runtime/package.json",
  "packages/server-runtime/package.json",
  "packages/electron-workspace-file-download/package.json",
];
const lockfiles = [
  "package-lock.json",
  "electron/package-lock.json",
  "packages/electron-local-server-runtime/package-lock.json",
  "packages/server-runtime/package-lock.json",
];
const versionModule = "src/shared/version.ts";
const versionPattern = /^export const SEDES_VERSION = "([^"]+)";$/mu;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

// Lockfile entries that describe this repository's own packages: the root
// entry and any workspace recorded under `packages/` or `electron`.
function workspaceLockKeys(lock) {
  return Object.keys(lock.packages ?? {}).filter(
    (key) => key === "" || key.startsWith("packages/") || key === "electron",
  ).filter((key) => key === "" || !key.includes("node_modules/"));
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

async function writeJson(relativePath, value) {
  await writeFile(path.join(repositoryRoot, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

async function collect() {
  const found = [];
  for (const relativePath of manifests) {
    found.push({ relativePath, version: (await readJson(relativePath)).version });
  }
  for (const relativePath of lockfiles) {
    const lock = await readJson(relativePath);
    found.push({ relativePath, version: lock.version });
    for (const key of workspaceLockKeys(lock)) {
      found.push({ relativePath: `${relativePath} (packages[${JSON.stringify(key)}])`, version: lock.packages[key].version });
    }
  }
  const source = await readFile(path.join(repositoryRoot, versionModule), "utf8");
  found.push({ relativePath: versionModule, version: source.match(versionPattern)?.[1] });
  return found;
}

async function check() {
  const found = await collect();
  const versions = new Set(found.map((entry) => entry.version));
  if (versions.size === 1 && !versions.has(undefined)) {
    console.log(`Version ${[...versions][0]} is consistent across ${found.length} locations.`);
    return 0;
  }
  console.error("Version-bearing files disagree:");
  for (const entry of found) console.error(`  ${entry.version ?? "(missing)"}  ${entry.relativePath}`);
  console.error("Run `npm run version:set -- X.Y.Z` to align them.");
  return 1;
}

async function set(version) {
  if (!semverPattern.test(version)) {
    console.error(`Not a semantic version: ${version}`);
    return 1;
  }
  for (const relativePath of manifests) {
    // Replace the text in place so hand-formatted manifests keep their layout.
    const manifestPath = path.join(repositoryRoot, relativePath);
    const text = await readFile(manifestPath, "utf8");
    const replaced = text.replace(/^(\s*"version":\s*)"[^"]*"/mu, `$1"${version}"`);
    if (replaced === text && !text.includes(`"version": "${version}"`)) {
      console.error(`${relativePath} has no top-level version field.`);
      return 1;
    }
    await writeFile(manifestPath, replaced);
  }
  for (const relativePath of lockfiles) {
    const lock = await readJson(relativePath);
    lock.version = version;
    for (const key of workspaceLockKeys(lock)) lock.packages[key].version = version;
    await writeJson(relativePath, lock);
  }
  const modulePath = path.join(repositoryRoot, versionModule);
  const source = await readFile(modulePath, "utf8");
  if (!versionPattern.test(source)) {
    console.error(`${versionModule} does not declare SEDES_VERSION.`);
    return 1;
  }
  await writeFile(modulePath, source.replace(versionPattern, `export const SEDES_VERSION = "${version}";`));
  console.log(`Set version ${version} in ${manifests.length + lockfiles.length + 1} files.`);
  return check();
}

const [command, argument] = process.argv.slice(2);
let exitCode;
if (command === "check") exitCode = await check();
else if (command === "set" && argument) exitCode = await set(argument);
else {
  console.error("Usage: node scripts/version.mjs check | set X.Y.Z");
  exitCode = 2;
}
process.exit(exitCode);
