#!/usr/bin/env node
// Copied with the kit so consumers can check their snapshot without a kit checkout.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function readPin(root) {
  const note = readFileSync(join(root, "VENDORED.md"), "utf8");
  const pins = [...note.matchAll(/^- Kit commit: `([0-9a-f]{40})`$/gm)];
  if (pins.length !== 1)
    throw new Error("VENDORED.md must name one committed kit revision");
  return pins[0][1];
}

export function filesUnder(root) {
  const files = [];
  function visit(relative) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(`symlink is not a vendored file: ${relative || root}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort())
        visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`not a regular file: ${relative}`);
    }
  }
  visit("");
  return files;
}

export function compareFiles(root, expected) {
  const actual = filesUnder(root).filter(
    (name) => name !== "VENDORED.md" && name !== "VENDORED.json",
  );
  const actualSet = new Set(actual);
  const problems = [];
  for (const name of Object.keys(expected).sort()) {
    if (!actualSet.has(name)) problems.push(`missing: ${name}`);
    else if (sha256(readFileSync(join(root, name))) !== expected[name])
      problems.push(`modified: ${name}`);
  }
  for (const name of actual)
    if (!Object.hasOwn(expected, name)) problems.push(`added: ${name}`);
  if (problems.length)
    throw new Error(`vendored copy differs:\n${problems.join("\n")}`);
}

export function verifyCopy(root) {
  // Inventory first: never follow a symlink to provenance or source outside the copy.
  filesUnder(root);
  const pin = readPin(root);
  const manifest = JSON.parse(
    readFileSync(join(root, "VENDORED.json"), "utf8"),
  );
  if (
    !manifest ||
    Object.keys(manifest).sort().join(",") !== "commit,files" ||
    manifest.commit !== pin ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    throw new Error("VENDORED.json does not describe the recorded kit commit");
  }
  const entries = Object.entries(manifest.files);
  if (!entries.length || !Object.hasOwn(manifest.files, "verify-vendor.mjs"))
    throw new Error("incomplete vendor manifest");
  for (const [name, digest] of entries) {
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      name === "VENDORED.md" ||
      name === "VENDORED.json" ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      throw new Error(`invalid vendor manifest entry: ${name}`);
    }
  }
  compareFiles(root, manifest.files);
  return pin;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("usage: node <vendored directory>/verify-vendor.mjs");
    const pin = verifyCopy(dirname(fileURLToPath(import.meta.url)));
    process.stdout.write(
      `workbench-ui ${pin}: vendored files match their recorded checksums\n`,
    );
  } catch (error) {
    process.stderr.write(`verify-vendor: ${error.message}\n`);
    process.exitCode = 1;
  }
}
