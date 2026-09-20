import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { prepareNodePtySpawnHelper } from "./prepare-node-pty.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const electronRoot = path.join(repositoryRoot, "electron");
const runtimeManifestRoot = path.join(
  repositoryRoot,
  "packages",
  "electron-local-server-runtime",
);
const stageRoot = path.join(electronRoot, "generated", "local-server");

async function writeManagedLocalDefaultConfiguration() {
  const source = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "config", "server.example.json"),
      "utf8",
    ),
  );
  if (
    source.schemaVersion !== 11 ||
    Object.keys(source).some(key => !["schemaVersion", "packagedClients", "listen"].includes(key)) ||
    !Array.isArray(source.packagedClients) ||
    source.packagedClients.length !== 0
  ) {
    throw new Error("electron_local_server_default_configuration_invalid");
  }
  await mkdir(path.join(stageRoot, "defaults"), { recursive: true });
  await writeFile(
    path.join(stageRoot, "defaults", "server.json"),
    `${JSON.stringify(
      { ...source, packagedClients: ["electron"] },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const packageName = (specifier) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/", 1)[0];

async function filesUnder(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

async function discoveredRuntimePackages(distRoot) {
  const packages = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
    /\.resolve\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const filename of await filesUnder(distRoot)) {
    const relative = path.relative(distRoot, filename);
    if (
      !filename.endsWith(".js") ||
      relative.startsWith(`client${path.sep}`) ||
      filename.endsWith(".test.js")
    ) {
      continue;
    }
    const source = await readFile(filename, "utf8");
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (
          specifier &&
          !specifier.startsWith("node:") &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("/")
        ) {
          packages.add(packageName(specifier));
        }
      }
    }
  }
  return [...packages].sort();
}

function includeRuntimeDistEntry(source) {
  return !(
    source.endsWith(".map") ||
    source.endsWith(".test.js") ||
    source.endsWith(".test.js.map")
  );
}

async function assertRuntimeManifest() {
  const [rootManifest, runtimeManifest] = await Promise.all([
    readFile(path.join(repositoryRoot, "package.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(runtimeManifestRoot, "package.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const dependencies = runtimeManifest.dependencies ?? {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (rootManifest.dependencies?.[name] !== version) {
      throw new Error(`electron_local_server_dependency_drift:${name}`);
    }
  }
  const missing = (
    await discoveredRuntimePackages(path.join(repositoryRoot, "dist"))
  ).filter((name) => dependencies[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `electron_local_server_runtime_dependencies_missing:${missing.join(",")}`,
    );
  }
  const codexVersion = rootManifest.devDependencies?.["@openai/codex"];
  if (!/^\d+\.\d+\.\d+$/u.test(codexVersion ?? "")) {
    throw new Error("electron_local_server_codex_version_invalid");
  }
  return { runtimeManifest, codexVersion };
}

async function resolveElectronRebuild() {
  const requireFromElectron = createRequire(
    path.join(electronRoot, "package.json"),
  );
  const rebuildEntry = requireFromElectron.resolve("@electron/rebuild");
  return import(pathToFileURL(rebuildEntry).href);
}

async function assertNativePayload() {
  const nativeFiles = (await filesUnder(path.join(stageRoot, "node_modules")))
    .filter((filename) => filename.endsWith(".node"))
    .map((filename) =>
      path.relative(stageRoot, filename).replaceAll("\\", "/"),
    );
  for (const requiredFragment of [
    `${betterSqlitePlatform()}-${process.arch}.node`,
    "pty.node",
  ]) {
    if (!nativeFiles.some((filename) => filename.endsWith(requiredFragment))) {
      throw new Error(
        `electron_local_server_native_module_missing:${requiredFragment}`,
      );
    }
  }
  await writeFile(
    path.join(stageRoot, "native-modules.json"),
    `${JSON.stringify({ platform: process.platform, architecture: process.arch, files: nativeFiles.sort() }, null, 2)}\n`,
    "utf8",
  );
}

function betterSqlitePlatform() {
  if (
    process.platform === "linux" &&
    !process.report.getReport().header.glibcVersionRuntime
  ) {
    return "linuxmusl";
  }
  return process.platform;
}

async function removeDirectoryEntriesExcept(directory, allowedNames) {
  const entries = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(
    entries
      .filter((name) => !allowedNames.has(name))
      .map((name) =>
        rm(path.join(directory, name), { force: true, recursive: true }),
      ),
  );
}

async function pruneProviderExecutablePackages(modulesRoot) {
  const entries = await readdir(modulesRoot, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  await Promise.all(
    entries
      .filter((entry) => entry.name === "@openai")
      .map((entry) =>
        rm(path.join(modulesRoot, entry.name), {
          force: true,
          recursive: true,
        }),
      ),
  );

  const anthropicEntry = entries.find(
    (entry) => entry.name === "@anthropic-ai",
  );
  const anthropicRoot = path.join(modulesRoot, "@anthropic-ai");
  if (anthropicEntry && !anthropicEntry.isDirectory()) {
    await rm(anthropicRoot, { force: true, recursive: true });
  }
  const anthropicPackages = anthropicEntry?.isDirectory()
    ? await readdir(anthropicRoot)
    : [];
  await Promise.all(
    anthropicPackages
      .filter((name) => name.startsWith("claude-agent-sdk-"))
      .map((name) =>
        rm(path.join(anthropicRoot, name), {
          force: true,
          recursive: true,
        }),
      ),
  );

  async function visitPackageDirectory(directory) {
    const children = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const childPath = path.join(directory, child.name);
      if (child.name === "node_modules") {
        await pruneProviderExecutablePackages(childPath);
      } else {
        await visitPackageDirectory(childPath);
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "@openai") continue;
    await visitPackageDirectory(path.join(modulesRoot, entry.name));
  }
}

async function pruneForeignNativePayload() {
  const modulesRoot = path.join(stageRoot, "node_modules");
  await pruneProviderExecutablePackages(modulesRoot);
  await removeDirectoryEntriesExcept(
    path.join(modulesRoot, "better-sqlite3", "prebuilds"),
    new Set([`${betterSqlitePlatform()}-${process.arch}.node`]),
  );
  await removeDirectoryEntriesExcept(
    path.join(modulesRoot, "node-pty", "prebuilds"),
    new Set([`${process.platform}-${process.arch}`]),
  );

  const piModulesRoot = path.join(
    modulesRoot,
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
  );
  await removeDirectoryEntriesExcept(
    path.join(piModulesRoot, "@earendil-works", "pi-tui", "native"),
    new Set([process.platform]),
  );
  await removeDirectoryEntriesExcept(
    path.join(
      piModulesRoot,
      "@earendil-works",
      "pi-tui",
      "native",
      process.platform,
      "prebuilds",
    ),
    new Set([`${process.platform}-${process.arch}`]),
  );
}

export async function prepareElectronLocalServer() {
  const distRoot = path.join(repositoryRoot, "dist");
  if (!(await stat(path.join(distRoot, "server", "index.js"))).isFile()) {
    throw new Error("electron_local_server_build_missing");
  }
  const { codexVersion } = await assertRuntimeManifest();
  await rm(stageRoot, { force: true, recursive: true });
  await mkdir(stageRoot, { recursive: true });
  await Promise.all([
    cp(
      path.join(runtimeManifestRoot, "package.json"),
      path.join(stageRoot, "package.json"),
    ),
    cp(
      path.join(runtimeManifestRoot, "package-lock.json"),
      path.join(stageRoot, "package-lock.json"),
    ),
  ]);

  const npmExecutable = process.env.npm_execpath;
  const npmCommand = npmExecutable
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const npmArguments = npmExecutable
    ? [npmExecutable, "ci", "--omit=dev", "--ignore-scripts"]
    : ["ci", "--omit=dev", "--ignore-scripts"];
  const installEnvironment = { ...process.env };
  delete installEnvironment.NODE_ENV;
  await execFileAsync(npmCommand, npmArguments, {
    cwd: stageRoot,
    env: installEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });

  const electronManifest = JSON.parse(
    await readFile(path.join(electronRoot, "package.json"), "utf8"),
  );
  const electronVersion = electronManifest.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/u.test(electronVersion ?? "")) {
    throw new Error("electron_local_server_electron_version_invalid");
  }
  const { rebuild } = await resolveElectronRebuild();
  await rebuild({
    buildPath: stageRoot,
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    force: true,
    mode: "sequential",
    types: ["prod", "optional"],
  });
  await pruneForeignNativePayload();
  const nodePtyRoot = path.join(stageRoot, "node_modules", "node-pty");
  await prepareNodePtySpawnHelper({
    platform: process.platform,
    architecture: process.arch,
    nodePtyRoot,
  });

  await Promise.all([
    cp(distRoot, path.join(stageRoot, "dist"), {
      recursive: true,
      filter: includeRuntimeDistEntry,
    }),
    writeManagedLocalDefaultConfiguration(),
    mkdir(path.join(stageRoot, "protocol", "codex-app-server", codexVersion), {
      recursive: true,
    }).then(() =>
      cp(
        path.join(
          repositoryRoot,
          "protocol",
          "codex-app-server",
          codexVersion,
          "release.json",
        ),
        path.join(
          stageRoot,
          "protocol",
          "codex-app-server",
          codexVersion,
          "release.json",
        ),
      ),
    ),
  ]);
  await assertNativePayload();
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareElectronLocalServer();
  process.stdout.write(`Electron Local server staged at ${stageRoot}.\n`);
}
