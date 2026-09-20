import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function collectMarkdown(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const details = await stat(absolutePath);
  if (details.isFile()) return [relativePath];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.name.endsWith(".md"))
      .map((entry) => collectMarkdown(path.join(relativePath, entry.name))),
  );
  return nested.flat();
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;

  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;

    const base = match[2]
      .toLowerCase()
      .replace(/<[^>]*>/gu, "")
      .replace(/[`*_~]/gu, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function localDestinations(markdown) {
  const destinations = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of markdown.matchAll(linkPattern)) {
    let destination = match[1].trim();
    if (destination.startsWith("<")) {
      const closing = destination.indexOf(">");
      destination = closing === -1 ? destination : destination.slice(1, closing);
    } else {
      destination = destination.split(/\s+/u, 1)[0];
    }
    if (
      !destination ||
      /^[a-z][a-z0-9+.-]*:/iu.test(destination)
    ) {
      continue;
    }
    destinations.push(destination);
  }
  return destinations;
}

const markdownFiles = (
  await Promise.all([
    collectMarkdown("README.md"),
    collectMarkdown("AGENTS.md"),
    collectMarkdown("CHANGELOG.md"),
    collectMarkdown("CONTRIBUTING.md"),
    collectMarkdown("SECURITY.md"),
    collectMarkdown("docs"),
    collectMarkdown("protocol"),
    collectMarkdown("skills"),
    collectMarkdown("electron/assets/README.md"),
    collectMarkdown("src/server/provider-protocol/bindings/acp-v1/README.md"),
  ])
).flat();

const failures = [];
const anchorCache = new Map();
const markdownLinkGraph = new Map();
let linkCount = 0;

for (const relativeSource of markdownFiles) {
  const sourcePath = path.join(repositoryRoot, relativeSource);
  const markdown = await readFile(sourcePath, "utf8");

  for (const destination of localDestinations(markdown)) {
    linkCount += 1;
    const hashIndex = destination.indexOf("#");
    const encodedPath =
      hashIndex === -1 ? destination : destination.slice(0, hashIndex);
    const encodedFragment =
      hashIndex === -1 ? "" : destination.slice(hashIndex + 1);
    const decodedPath = decodeURIComponent(encodedPath);
    const targetPath = decodedPath
      ? path.resolve(path.dirname(sourcePath), decodedPath)
      : sourcePath;

    try {
      await access(targetPath);
    } catch {
      failures.push(`${relativeSource}: missing local target ${destination}`);
      continue;
    }

    if (path.extname(targetPath).toLowerCase() === ".md") {
      const relativeTarget = path.relative(repositoryRoot, targetPath);
      const targets = markdownLinkGraph.get(relativeSource) ?? new Set();
      targets.add(relativeTarget);
      markdownLinkGraph.set(relativeSource, targets);
    }

    if (!encodedFragment || path.extname(targetPath).toLowerCase() !== ".md") {
      continue;
    }

    let anchors = anchorCache.get(targetPath);
    if (!anchors) {
      anchors = headingAnchors(await readFile(targetPath, "utf8"));
      anchorCache.set(targetPath, anchors);
    }
    const fragment = decodeURIComponent(encodedFragment).toLowerCase();
    if (!anchors.has(fragment)) {
      failures.push(`${relativeSource}: missing heading ${destination}`);
    }
  }
}

const documentationFiles = new Set(
  markdownFiles.filter((relativePath) => relativePath.startsWith("docs/")),
);
const reachableDocumentation = new Set();
const pendingDocumentation = ["docs/index.md"];

while (pendingDocumentation.length > 0) {
  const relativeSource = pendingDocumentation.pop();
  if (
    !relativeSource ||
    reachableDocumentation.has(relativeSource) ||
    !documentationFiles.has(relativeSource)
  ) {
    continue;
  }

  reachableDocumentation.add(relativeSource);
  for (const relativeTarget of markdownLinkGraph.get(relativeSource) ?? []) {
    if (
      documentationFiles.has(relativeTarget) &&
      !reachableDocumentation.has(relativeTarget)
    ) {
      pendingDocumentation.push(relativeTarget);
    }
  }
}

for (const relativePath of documentationFiles) {
  if (!reachableDocumentation.has(relativePath)) {
    failures.push(`${relativePath}: not reachable from docs/index.md`);
  }
}

// Every page must be listed by a section index, not merely reachable through
// body prose, so that a reader browsing the index files can find it.
for (const relativePath of documentationFiles) {
  if (path.basename(relativePath) === "index.md") continue;
  const directory = path.posix.dirname(relativePath);
  const candidateIndexes = new Set([
    path.posix.join(directory, "index.md"),
    path.posix.join(path.posix.dirname(directory), "index.md"),
    "docs/index.md",
  ]);
  const listed = [...candidateIndexes].some((indexPath) =>
    documentationFiles.has(indexPath) &&
    (markdownLinkGraph.get(indexPath) ?? new Set()).has(relativePath),
  );
  if (!listed) {
    failures.push(`${relativePath}: not linked from a section index`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation check passed (${markdownFiles.length} files, ${linkCount} local links; ${reachableDocumentation.size} indexed docs).`,
  );
}
