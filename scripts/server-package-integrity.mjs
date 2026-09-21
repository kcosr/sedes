import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";

const inventories = new Set(["FILES.json", "SHA256SUMS"]);
const installationFiles = new Set(["RELEASE.json"]);
async function digest(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
function safeRelative(relative) {
  return typeof relative === "string" && relative !== "" &&
    !relative.includes("\\") && !relative.includes("\n") && !relative.includes("\r") &&
    !path.posix.isAbsolute(relative) && relative.split("/").every((part) => part !== "." && part !== ".." && part !== "");
}
async function inventory(root, installed = false) {
  const entries = {};
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(relative)) throw new Error(`Invalid package path: ${relative}`);
      if (inventories.has(relative) || (installed && installationFiles.has(relative))) continue;
      const filename = path.join(directory, name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) {
        const target = await readlink(filename);
        const resolved = path.resolve(path.dirname(filename), target);
        if (path.isAbsolute(target) || !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
          throw new Error(`Package symlink escapes release: ${relative}`);
        }
        entries[relative] = { type: "symlink", target };
      } else if (stat.isDirectory()) {
        await walk(filename, relative);
      } else if (stat.isFile()) {
        entries[relative] = { type: "file", mode: stat.mode & 0o777, sha256: await digest(filename) };
      } else throw new Error(`Unsupported package entry: ${relative}`);
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, "en")));
}
function checksumContents(entries, inventoryHash) {
  return [...Object.entries(entries).filter(([, entry]) => entry.type === "file")
    .map(([name, entry]) => `${entry.sha256}  ${name}`), `${inventoryHash}  FILES.json`].sort().join("\n") + "\n";
}

/** Record every shipped file, executable permission, and relative symlink. */
export async function writePackageIntegrity(root) {
  const entries = await inventory(root);
  await writeFile(path.join(root, "FILES.json"), `${JSON.stringify(entries, null, 2)}\n`);
  await writeFile(path.join(root, "SHA256SUMS"), checksumContents(entries, await digest(path.join(root, "FILES.json"))));
}

export function checkPackageCompatibility(info, {
  platform = process.platform, arch = process.arch,
  nodeVersion = process.version, nodeAbi = process.versions.modules,
} = {}) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(nodeVersion);
  if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 18)) {
    throw new Error("Sedes server packages require Node.js 24.18.0 or newer.");
  }
  const targets = { "linux:x64": "linux-x86_64", "linux:arm64": "linux-arm64", "darwin:x64": "macos-x86_64", "darwin:arm64": "macos-arm64" };
  if (info.format !== 1 || info.node?.minimum !== "24.18.0" ||
      info.target?.label !== targets[`${info.target?.platform}:${info.target?.arch}`] ||
      !info.target?.label || typeof info.version !== "string" ||
      !/^[0-9a-f]{40}$/u.test(info.source?.commit ?? "")) {
    throw new Error("Invalid Sedes server BUILD-INFO.json metadata.");
  }
  if (info.target.platform !== platform || info.target.arch !== arch) {
    throw new Error(`Package target ${info.target.label} does not match ${platform}/${arch}.`);
  }
  if (String(info.node.abi) !== String(nodeAbi)) {
    throw new Error(`Package Node ABI ${info.node.abi} does not match runtime ABI ${nodeAbi}; build a package for this Node runtime.`);
  }
}

/** Checksums detect transfer/copy damage; authenticate archives through a trusted channel. */
export async function verifyPackageIntegrity(root, { installed = false, ...compatibility } = {}) {
  for (const name of inventories) {
    if (!(await lstat(path.join(root, name))).isFile()) throw new Error(`Invalid package inventory: ${name}`);
  }
  const expected = JSON.parse(await readFile(path.join(root, "FILES.json"), "utf8"));
  const actual = await inventory(root, installed);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const changed = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const failed = [...changed].filter((name) => JSON.stringify(expected[name]) !== JSON.stringify(actual[name]));
    throw new Error(`Package integrity mismatch: ${failed.slice(0, 8).join(", ")}`);
  }
  const checksums = await readFile(path.join(root, "SHA256SUMS"), "utf8");
  if (checksums !== checksumContents(actual, await digest(path.join(root, "FILES.json")))) {
    throw new Error("Package SHA256SUMS mismatch.");
  }
  const info = JSON.parse(await readFile(path.join(root, "BUILD-INFO.json"), "utf8"));
  checkPackageCompatibility(info, compatibility);
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.version !== info.version || manifest.name !== "@sedes/server-runtime") {
    throw new Error("Package manifest does not match server build metadata.");
  }
  return info;
}
