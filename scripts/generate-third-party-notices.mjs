#!/usr/bin/env node
// Generates THIRD-PARTY-NOTICES.md from the production dependency closure of
// the root package, the workspaces under packages/*, and electron/.
//
//   node scripts/generate-third-party-notices.mjs          # write the file
//   node scripts/generate-third-party-notices.mjs --check   # verify it is current
//
// package-lock.json is the source of truth for what is installed. A root
// directory that owns a package-lock.json (packages/server-runtime,
// electron/) is walked through that lockfile, because packaging installs it from
// there and it can pin versions the root lockfile does not have. Package
// directories under node_modules supply license metadata and license text.
// devDependencies are excluded.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const noticesPath = path.join(repositoryRoot, "THIRD-PARTY-NOTICES.md");
const lockPath = path.join(repositoryRoot, "package-lock.json");

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([-._].*)?$/iu;
const KEY_LENGTH = 12;

function readJson(absolutePath) {
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

function isDirectory(absolutePath) {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function packageNameFromPath(installedPath) {
  const marker = installedPath.lastIndexOf("node_modules/");
  return marker === -1
    ? installedPath
    : installedPath.slice(marker + "node_modules/".length);
}

/** Walks up the nested node_modules chain the way Node resolution does. */
function resolveInstalledPath(lockPackages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = base
      ? `${base}/node_modules/${name}`
      : `node_modules/${name}`;
    if (lockPackages[candidate]) return candidate;
    const nested = base.lastIndexOf("/node_modules/");
    if (nested !== -1) {
      base = base.slice(0, nested);
      continue;
    }
    if (base !== "") {
      // A workspace directory (packages/foo) falls back to the root store.
      base = "";
      continue;
    }
    return null;
  }
}

/** Resolves workspace links (`link: true`) to the real lock entry. */
function dereference(lockPackages, lockPath_) {
  let current = lockPath_;
  for (let hops = 0; hops < 8; hops += 1) {
    const entry = lockPackages[current];
    if (!entry?.link || !entry.resolved) return current;
    current = entry.resolved;
  }
  return current;
}

/**
 * Describes one closure root. A root whose directory owns a package-lock.json
 * is walked through that lockfile (`ownLockfile`), starting at its `""` entry;
 * every other root is walked through the repository lockfile.
 */
function makeRoot(directory, manifest, fallbackLabel, rootLockPackages) {
  const ownLock =
    directory === ""
      ? null
      : readJson(path.join(repositoryRoot, directory, "package-lock.json"));
  const ownLockPackages = ownLock?.packages ?? null;
  return {
    label: manifest.name ?? fallbackLabel,
    directory,
    manifest,
    lockPackages: ownLockPackages ?? rootLockPackages,
    ownLockfile: ownLockPackages !== null,
    // Where the walk starts inside the lockfile that describes this root.
    startPath: ownLockPackages ? "" : rootLockPackages[directory] ? directory : "",
    // Where that lockfile's paths land on disk.
    installBase: ownLockPackages ? directory : "",
  };
}

function collectRoots(rootLockPackages) {
  const roots = [];
  const rootManifest = readJson(path.join(repositoryRoot, "package.json"));
  if (rootManifest) {
    roots.push(makeRoot("", rootManifest, "sedes", rootLockPackages));
  }

  const packagesDir = path.join(repositoryRoot, "packages");
  if (isDirectory(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `packages/${entry.name}`;
      const manifest = readJson(
        path.join(packagesDir, entry.name, "package.json"),
      );
      if (!manifest) continue;
      roots.push(makeRoot(relative, manifest, relative, rootLockPackages));
    }
  }

  const electronManifest = readJson(
    path.join(repositoryRoot, "electron", "package.json"),
  );
  if (electronManifest) {
    roots.push(
      makeRoot("electron", electronManifest, "electron", rootLockPackages),
    );
  }

  return roots;
}

/**
 * Indexes every installed package directory in the repository tree by
 * `name@version`, so a workspace lockfile entry that is not installed under the
 * workspace itself can still borrow license text from an identical copy.
 */
function buildInstalledIndex(rootLockPackages) {
  const index = new Map();
  for (const [key, entry] of Object.entries(rootLockPackages)) {
    if (!key.includes("node_modules/") || entry.link) continue;
    const identity = `${packageNameFromPath(key)}@${entry.version}`;
    if (index.has(identity)) continue;
    if (!isDirectory(path.join(repositoryRoot, key))) continue;
    index.set(identity, key);
  }
  return index;
}

/** Absolute directory holding the package's files, or null if none is present. */
function locatePackageDirectory(root, target, entry, installedIndex) {
  const direct = path.join(repositoryRoot, root.installBase, target);
  if (isDirectory(direct)) return direct;
  if (!root.ownLockfile) return null;
  const fallback = installedIndex.get(
    `${packageNameFromPath(target)}@${entry.version}`,
  );
  return fallback === undefined ? null : path.join(repositoryRoot, fallback);
}

/**
 * Walks one root's production closure. Only `dependencies`, installed
 * `optionalDependencies`, and required `peerDependencies` are followed;
 * devDependencies are never entered.
 */
function collectProductionClosure(root, installedIndex) {
  const lockPackages = root.lockPackages;
  const visited = new Set();
  const found = [];
  const missing = [];
  const unresolved = [];
  const queue = [];

  for (const name of Object.keys(root.manifest.dependencies ?? {})) {
    queue.push({ from: root.startPath, name, via: root.label });
  }

  while (queue.length > 0) {
    const { from, name, via } = queue.pop();
    // A workspace lockfile records its sibling @sedes/* workspaces as links to
    // first-party source, which carries no third-party notice.
    if (root.ownLockfile && name.startsWith("@sedes/")) continue;
    const resolvedPath = resolveInstalledPath(lockPackages, from, name);
    if (!resolvedPath) {
      unresolved.push(`${name} (required by ${via || "<root>"})`);
      continue;
    }
    const target = dereference(lockPackages, resolvedPath);
    if (visited.has(target)) continue;
    visited.add(target);

    const entry = lockPackages[target] ?? {};
    if (root.ownLockfile && entry.link) continue;
    const packageDirectory = locatePackageDirectory(
      root,
      target,
      entry,
      installedIndex,
    );
    if (
      packageDirectory === null &&
      (!root.ownLockfile || entry.optional === true)
    ) {
      // Platform-specific or pruned optional dependencies are recorded in the
      // lockfile but are not present in this tree, so they are not shipped.
      visited.delete(target);
      missing.push(`${packageNameFromPath(target)} ${entry.version ?? "?"}`);
      continue;
    }
    // A required workspace-lockfile entry with no local copy is still shipped;
    // it is listed from lockfile metadata without license text.
    found.push({ installedPath: target, entry, packageDirectory });

    const peerMeta = entry.peerDependenciesMeta ?? {};
    const dependencyNames = [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      // Required peers are installed into the tree by npm and load at runtime.
      ...Object.keys(entry.peerDependencies ?? {}).filter(
        (peerName) => peerMeta[peerName]?.optional !== true,
      ),
    ];
    for (const dependencyName of dependencyNames) {
      queue.push({ from: target, name: dependencyName, via: target });
    }
  }

  return { found, missing, unresolved };
}

function normalizeRepositoryUrl(value) {
  if (!value) return null;
  let url = typeof value === "string" ? value : value.url;
  if (typeof url !== "string" || url.length === 0) return null;
  url = url.trim();
  if (/^[\w.-]+\/[\w.-]+$/u.test(url)) url = `https://github.com/${url}`;
  if (url.startsWith("github:")) {
    url = `https://github.com/${url.slice("github:".length)}`;
  }
  url = url.replace(/^git\+/u, "");
  url = url.replace(/^git:\/\//u, "https://");
  url = url.replace(/^ssh:\/\/git@/u, "https://");
  url = url.replace(/^git@([^:]+):/u, "https://$1/");
  url = url.replace(/\.git$/u, "");
  const directory =
    typeof value === "object" && typeof value.directory === "string"
      ? value.directory
      : null;
  if (directory && /^https:\/\/github\.com\//u.test(url)) {
    url = `${url}/tree/HEAD/${directory}`;
  }
  return url;
}

function licenseIdentifier(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) {
    return manifest.license.trim();
  }
  if (manifest.license && typeof manifest.license === "object") {
    const legacy = manifest.license.type ?? manifest.license.name;
    if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  }
  if (Array.isArray(manifest.licenses)) {
    const identifiers = manifest.licenses
      .map((item) =>
        typeof item === "string" ? item : (item?.type ?? item?.name),
      )
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
    if (identifiers.length === 1) return identifiers[0];
    if (identifiers.length > 1) return `(${identifiers.join(" OR ")})`;
  }
  return null;
}

function normalizeLicenseText(text) {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

function readLicenseFiles(packageDirectory) {
  let entries;
  try {
    entries = readdirSync(packageDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const base = entry.name.replace(/\.(md|markdown|txt|rst)$/iu, "");
    if (!LICENSE_FILE_PATTERN.test(base)) continue;
    let text;
    try {
      text = readFileSync(path.join(packageDirectory, entry.name), "utf8");
    } catch {
      continue;
    }
    const normalized = normalizeLicenseText(text);
    if (normalized.length === 0) continue;
    files.push({ fileName: entry.name, text: normalized });
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function describePackage(installedPath, lockEntry, packageDirectory) {
  if (packageDirectory === null) {
    // Recorded in a workspace lockfile but not installed anywhere in this
    // tree: lockfileVersion 3 still carries the version and license identifier.
    return {
      installedPath,
      name: packageNameFromPath(installedPath),
      version: lockEntry.version ?? "unknown",
      license: licenseIdentifier(lockEntry),
      url: null,
      licenseFiles: [],
      private: false,
      hasDirectory: false,
    };
  }
  const manifest = readJson(path.join(packageDirectory, "package.json")) ?? {};
  const name = manifest.name ?? packageNameFromPath(installedPath);
  return {
    installedPath,
    name,
    version: manifest.version ?? lockEntry.version ?? "unknown",
    license: licenseIdentifier(manifest) ?? licenseIdentifier(lockEntry),
    url:
      normalizeRepositoryUrl(manifest.repository) ??
      normalizeRepositoryUrl(manifest.homepage) ??
      (typeof manifest.homepage === "string" ? manifest.homepage : null),
    licenseFiles: readLicenseFiles(packageDirectory),
    private: manifest.private === true,
    hasDirectory: true,
  };
}

function renderNotices(packages, licenseTexts) {
  const lines = [];
  lines.push("# Third-party notices");
  lines.push("");
  lines.push("Sedes is distributed under the MIT License; see [LICENSE](LICENSE) for its terms.");
  lines.push("The repository contains Sedes source only and commits no third-party code.");
  lines.push("Building or installing Sedes pulls its dependencies from npm, and a built");
  lines.push("installation or packaged artifact then contains them. This file lists that");
  lines.push("production dependency closure with each package's license identifier and,");
  lines.push("where the package ships one, its full license text, so that anyone who");
  lines.push("distributes a built artifact can meet the attribution and license-retention");
  lines.push("terms of the packages inside it.");
  lines.push("");
  lines.push("The closure covers the root package, the workspaces under `packages/`, and");
  lines.push("`electron/`, and excludes devDependencies. `package-lock.json` is the source");
  lines.push("of truth for what is installed, and a root that owns a `package-lock.json` is");
  lines.push("walked through that workspace lockfile because packaging installs it from");
  lines.push("there; `dependencies`, installed `optionalDependencies`, and required");
  lines.push("`peerDependencies` are followed transitively through nested `node_modules`.");
  lines.push("Each entry names the roots that ship it, so a package pinned at two versions");
  lines.push("is listed once per version. Packages recorded in the lockfile");
  lines.push("but absent from an installed tree (for example the platform-specific Claude");
  lines.push("Code executable packages, which the `postinstall` step removes) are not part");
  lines.push("of a built installation and are not listed.");
  lines.push("");
  lines.push(
    "This file is generated. Run `npm run generate:third-party-notices` to refresh it",
  );
  lines.push(
    "and `npm run check:third-party-notices` to verify that it is current.",
  );
  lines.push("");
  lines.push(`Packages listed: ${packages.length}.`);
  lines.push("");
  lines.push("## Packages");
  lines.push("");

  for (const entry of packages) {
    lines.push(`### ${entry.name} ${entry.version}`);
    lines.push("");
    lines.push(`- License: ${entry.license ?? "not declared in package metadata"}`);
    lines.push(`- URL: ${entry.url ?? "not declared in package metadata"}`);
    lines.push(`- Shipped by: ${entry.roots.join(", ")}`);
    if (entry.licenseFiles.length === 0) {
      lines.push(
        "- License text: license text not included in package; see repository",
      );
    } else {
      for (const file of entry.licenseFiles) {
        lines.push(
          `- License text (\`${file.fileName}\`): [${file.key}](#license-text-${file.key})`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## License texts");
  lines.push("");
  lines.push(
    "Each license text below is stored once and keyed by the first",
  );
  lines.push(
    `${KEY_LENGTH} hexadecimal characters of the SHA-256 digest of its normalized`,
  );
  lines.push(
    "text (CRLF normalized to LF, trailing whitespace removed). Package entries",
  );
  lines.push("above reference the text that applies to them.");
  lines.push("");

  for (const text of licenseTexts) {
    lines.push(`### License text ${text.key}`);
    lines.push("");
    lines.push(`Applies to: ${text.users.join(", ")}.`);
    lines.push("");
    lines.push("```text");
    lines.push(...text.text.split("\n"));
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

function build() {
  const lock = readJson(lockPath);
  if (!lock?.packages) {
    throw new Error(`Unable to read package entries from ${lockPath}`);
  }
  const rootLockPackages = lock.packages;
  const installedIndex = buildInstalledIndex(rootLockPackages);
  const roots = collectRoots(rootLockPackages);

  const missing = [];
  const unresolved = [];
  const byIdentity = new Map();
  for (const root of roots) {
    const closure = collectProductionClosure(root, installedIndex);
    missing.push(...closure.missing);
    unresolved.push(...closure.unresolved);
    for (const item of closure.found) {
      if (!item.installedPath.includes("node_modules/")) continue;
      const described = describePackage(
        item.installedPath,
        item.entry,
        item.packageDirectory,
      );
      if (described.private) continue;
      const identity = `${described.name}@${described.version}`;
      const existing = byIdentity.get(identity);
      if (existing === undefined) {
        byIdentity.set(identity, { entry: described, roots: [root.label] });
        continue;
      }
      if (!existing.roots.includes(root.label)) existing.roots.push(root.label);
      // Prefer a description backed by real files over lockfile metadata.
      if (!existing.entry.hasDirectory && described.hasDirectory) {
        existing.entry = described;
      }
    }
  }

  const packages = [...byIdentity.values()]
    .map(({ entry, roots: shippedBy }) => ({ ...entry, roots: shippedBy }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );

  const textsByKey = new Map();
  for (const entry of packages) {
    for (const file of entry.licenseFiles) {
      const key = createHash("sha256")
        .update(file.text)
        .digest("hex")
        .slice(0, KEY_LENGTH);
      file.key = key;
      const existing = textsByKey.get(key);
      if (existing) {
        existing.users.push(`${entry.name} ${entry.version}`);
      } else {
        textsByKey.set(key, {
          key,
          text: file.text,
          users: [`${entry.name} ${entry.version}`],
        });
      }
    }
  }
  const licenseTexts = [...textsByKey.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  for (const text of licenseTexts) {
    text.users = [...new Set(text.users)].sort((a, b) => a.localeCompare(b));
  }

  return {
    markdown: renderNotices(packages, licenseTexts),
    packages,
    licenseTexts,
    missing: [...new Set(missing)].sort(),
    unresolved: [...new Set(unresolved)].sort(),
  };
}

function packageIndex(markdown) {
  const index = new Map();
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = /^### (\S.*?) (\S+)$/u.exec(line);
    if (heading && !line.startsWith("### License text ")) {
      current = `${heading[1]}@${heading[2]}`;
      index.set(current, []);
      continue;
    }
    if (line.startsWith("## ")) current = null;
    if (current) index.get(current).push(line);
  }
  return index;
}

function diffSummary(expected, actual) {
  const expectedIndex = packageIndex(expected);
  const actualIndex = packageIndex(actual);
  const added = [...expectedIndex.keys()].filter((key) => !actualIndex.has(key));
  const removed = [...actualIndex.keys()].filter(
    (key) => !expectedIndex.has(key),
  );
  const changed = [...expectedIndex.keys()].filter(
    (key) =>
      actualIndex.has(key) &&
      actualIndex.get(key).join("\n") !== expectedIndex.get(key).join("\n"),
  );
  const lines = [];
  lines.push(
    `THIRD-PARTY-NOTICES.md is out of date (${expected.split("\n").length} generated lines vs ${actual.split("\n").length} committed lines).`,
  );
  if (added.length > 0) {
    lines.push(`Missing from the file (${added.length}): ${added.join(", ")}`);
  }
  if (removed.length > 0) {
    lines.push(`No longer installed (${removed.length}): ${removed.join(", ")}`);
  }
  if (changed.length > 0) {
    lines.push(`Changed metadata (${changed.length}): ${changed.join(", ")}`);
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push(
      "Package list matches; preamble, license texts, or formatting differ.",
    );
  }
  lines.push("Run `npm run generate:third-party-notices` to refresh it.");
  return lines.join("\n");
}

function reportAnomalies(result) {
  for (const description of result.missing) {
    console.warn(
      `note: ${description} is recorded in package-lock.json but is not installed in this tree (platform-specific or pruned optional dependency); omitted.`,
    );
  }
  for (const description of result.unresolved) {
    console.warn(`warning: unresolved production dependency ${description}`);
  }
  const undeclared = result.packages.filter((entry) => !entry.license);
  for (const entry of undeclared) {
    console.warn(
      `warning: ${entry.name} ${entry.version} declares no license identifier.`,
    );
  }
}

const check = process.argv.includes("--check");
const result = build();
reportAnomalies(result);

if (check) {
  let actual = null;
  try {
    actual = readFileSync(noticesPath, "utf8");
  } catch {
    console.error(
      "THIRD-PARTY-NOTICES.md is missing. Run `npm run generate:third-party-notices`.",
    );
    process.exit(1);
  }
  if (actual !== result.markdown) {
    console.error(diffSummary(result.markdown, actual));
    process.exit(1);
  }
  console.log(
    `THIRD-PARTY-NOTICES.md is up to date (${result.packages.length} packages, ${result.licenseTexts.length} license texts).`,
  );
} else {
  writeFileSync(noticesPath, result.markdown);
  console.log(
    `Wrote THIRD-PARTY-NOTICES.md (${result.packages.length} packages, ${result.licenseTexts.length} license texts).`,
  );
}
