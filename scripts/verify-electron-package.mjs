import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { electronBuilderUnpackedDirectory } from "./electron-package-layout.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedAppId = "dev.sedes.local";
const mode = process.argv[2];
if (mode !== "--synced" && mode !== "--packaged") {
  throw new Error("Usage: verify-electron-package.mjs --synced|--packaged");
}

async function filesUnder(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory())
        await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`electron_package_unexpected_entry:${relative}`);
    }
  }
  await visit(root);
  return files.sort();
}

async function packagedEntriesUnder(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory())
        await visit(path.join(directory, entry.name), relative);
      else entries.push(relative.replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return entries.sort();
}

async function directoryEntriesIfPresent(root) {
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new Error(`electron_package_expected_directory:${root}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return packagedEntriesUnder(root);
}

async function findProviderExecutablePackage(modulesRoot, relativeRoot) {
  const entries = await readdir(modulesRoot, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    },
  );
  if (entries.some((entry) => entry.name === "@openai")) {
    return `${relativeRoot}/@openai`;
  }

  const anthropicEntry = entries.find(
    (entry) => entry.name === "@anthropic-ai",
  );
  if (anthropicEntry && !anthropicEntry.isDirectory()) {
    return `${relativeRoot}/@anthropic-ai`;
  }
  const anthropicRoot = path.join(modulesRoot, "@anthropic-ai");
  const anthropicPackages = anthropicEntry
    ? await readdir(anthropicRoot, { withFileTypes: true })
    : [];
  const forbiddenAnthropic = anthropicPackages.find((entry) =>
    entry.name.startsWith("claude-agent-sdk-"),
  );
  if (forbiddenAnthropic) {
    return `${relativeRoot}/@anthropic-ai/${forbiddenAnthropic.name}`;
  }

  async function visitPackageDirectory(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const childPath = path.join(directory, child.name);
      const childRelative = `${relativeDirectory}/${child.name}`;
      if (child.name === "node_modules") {
        const forbidden = await findProviderExecutablePackage(
          childPath,
          childRelative,
        );
        if (forbidden) return forbidden;
      } else {
        const forbidden = await visitPackageDirectory(childPath, childRelative);
        if (forbidden) return forbidden;
      }
    }
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "@openai") continue;
    const forbidden = await visitPackageDirectory(
      path.join(modulesRoot, entry.name),
      `${relativeRoot}/${entry.name}`,
    );
    if (forbidden) return forbidden;
  }
  return undefined;
}

async function digest(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
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

async function verifySynced() {
  const clientRoot = path.join(repositoryRoot, "dist", "client");
  const appRoot = path.join(repositoryRoot, "electron", "app");
  const [clientFiles, appFiles] = await Promise.all([
    filesUnder(clientRoot),
    filesUnder(appRoot),
  ]);
  if (JSON.stringify(clientFiles) !== JSON.stringify(appFiles)) {
    throw new Error("electron_synced_asset_listing_mismatch");
  }
  for (const relative of clientFiles) {
    if (
      (await digest(path.join(clientRoot, relative))) !==
      (await digest(path.join(appRoot, relative)))
    ) {
      throw new Error(`electron_synced_asset_digest_mismatch:${relative}`);
    }
  }
  const index = await readFile(path.join(appRoot, "index.html"), "utf8");
  for (const directive of [
    "connect-src 'self' data: http: https: ws: wss:",
    "object-src 'none'",
  ]) {
    if (!index.includes(directive)) {
      throw new Error(`electron_synced_csp_missing:${directive}`);
    }
  }
  const config = await readFile(
    path.join(repositoryRoot, "electron", "capacitor.electron.config.ts"),
    "utf8",
  );
  for (const invariant of [
    "scheme: 'capacitor-electron'",
    "hostname: 'localhost'",
    "frame-ancestors 'none'",
    "permission === 'clipboard-sanitized-write'",
    "requestingWebContents === windowWebContents",
    "isPackagedRendererUrl(requestingUrl)",
    "setPermissionCheckHandler(handlePermissionCheck)",
    "setPermissionRequestHandler(handlePermissionRequest)",
  ]) {
    if (!config.includes(invariant)) {
      throw new Error(`electron_security_invariant_missing:${invariant}`);
    }
  }
  const builderConfig = await readFile(
    path.join(repositoryRoot, "electron", "electron-builder.config.js"),
    "utf8",
  );
  if (!builderConfig.includes(`appId: '${expectedAppId}'`)) {
    throw new Error("electron_application_id_changed");
  }
  const manifest = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "electron",
        "generated",
        "plugin-manifest.json",
      ),
      "utf8",
    ),
  );
  if (
    manifest.platformVersion !== "0.1.0" ||
    JSON.stringify(manifest.plugins) !==
      JSON.stringify([
        {
          packageName: "@sedes/electron-client-credentials",
          specifier: "@sedes/electron-client-credentials/electron/dist/plugin.mjs",
        },
        {
          packageName: "@sedes/electron-connection-runtime",
          specifier:
            "@sedes/electron-connection-runtime/electron/dist/plugin.mjs",
        },
        {
          packageName: "@sedes/electron-workspace-file-download",
          specifier:
            "@sedes/electron-workspace-file-download/electron/dist/plugin.mjs",
        },
      ])
  ) {
    throw new Error("electron_plugin_manifest_unexpected");
  }
  process.stdout.write(
    `Electron sync verified (${clientFiles.length} assets).\n`,
  );
}

async function verifyPackaged() {
  const unpackedName = electronBuilderUnpackedDirectory(
    process.platform,
    process.arch,
  );
  const unpackedRoot = path.join(
    repositoryRoot,
    "electron",
    "dist",
    unpackedName,
  );
  const resourcesRoot = path.join(unpackedRoot, "resources");
  const localServerRoot = path.join(resourcesRoot, "local-server");
  const asar = path.join(resourcesRoot, "app.asar");
  if (!(await stat(asar)).isFile())
    throw new Error("electron_app_asar_missing");
  const asarCli = path.join(
    repositoryRoot,
    "electron",
    "node_modules",
    "@electron",
    "asar",
    "bin",
    "asar.js",
  );
  const listing = execFileSync(process.execPath, [asarCli, "list", asar], {
    encoding: "utf8",
  });
  const entries = listing
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  const unpackedAsarEntries = (
    await directoryEntriesIfPresent(
      path.join(resourcesRoot, "app.asar.unpacked"),
    )
  ).map((entry) => `/${entry}`);
  for (const entry of unpackedAsarEntries) {
    if (!entries.includes(entry)) {
      throw new Error(`electron_packaged_untracked_unpacked_entry:${entry}`);
    }
  }
  const applicationEntries = [...new Set([...entries, ...unpackedAsarEntries])];
  const entrySet = new Set(applicationEntries);
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const codexVersion = rootManifest.devDependencies?.["@openai/codex"];
  if (!/^\d+\.\d+\.\d+$/u.test(codexVersion ?? "")) {
    throw new Error("electron_local_server_codex_version_invalid");
  }
  for (const required of [
    "/build/main.js",
    "/app/index.html",
    "/generated/plugin-manifest.json",
    "/node_modules/@capawesome/capacitor-electron/package.json",
    "/node_modules/@sedes/electron-client-credentials/package.json",
    "/node_modules/@sedes/electron-client-credentials/electron/dist/plugin.mjs",
    "/node_modules/@sedes/electron-connection-runtime/package.json",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/plugin.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/local-server-manager.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/ssh-tunnel-manager.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/ssh-port-store.mjs",
    "/node_modules/@sedes/electron-workspace-file-download/package.json",
    "/node_modules/@sedes/electron-workspace-file-download/electron/dist/plugin.mjs",
  ]) {
    if (!entrySet.has(required)) {
      throw new Error(`electron_packaged_entry_missing:${required}`);
    }
  }

  const allowedSedesEntries = new Set([
    "/node_modules/@sedes",
    "/node_modules/@sedes/electron-client-credentials",
    "/node_modules/@sedes/electron-client-credentials/electron",
    "/node_modules/@sedes/electron-client-credentials/electron/dist",
    "/node_modules/@sedes/electron-connection-runtime",
    "/node_modules/@sedes/electron-connection-runtime/electron",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/local-server-manager.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/plugin.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/ssh-tunnel-manager.mjs",
    "/node_modules/@sedes/electron-connection-runtime/electron/dist/ssh-port-store.mjs",
    "/node_modules/@sedes/electron-client-credentials/package.json",
    "/node_modules/@sedes/electron-client-credentials/electron/dist/plugin.mjs",
    "/node_modules/@sedes/electron-connection-runtime/package.json",
    "/node_modules/@sedes/electron-workspace-file-download",
    "/node_modules/@sedes/electron-workspace-file-download/electron",
    "/node_modules/@sedes/electron-workspace-file-download/electron/dist",
    "/node_modules/@sedes/electron-workspace-file-download/electron/dist/plugin.mjs",
    "/node_modules/@sedes/electron-workspace-file-download/package.json",
  ]);
  for (const entry of applicationEntries) {
    if (
      entry.startsWith("/node_modules/@sedes/") &&
      !allowedSedesEntries.has(entry)
    ) {
      throw new Error(`electron_packaged_unexpected_sedes_entry:${entry}`);
    }
  }

  const forbiddenEntryPatterns = [
    /^\/(?:resources\/)?(?:build|dist|src)\/(?:backend|server)(?:[./]|$)/u,
    /^\/(?:resources\/)?(?:backend|server)(?:[./]|$)/u,
    /^\/(?:resources\/)?config\/(?:backend|server)(?:[./]|$)/u,
    /^\/node_modules\/(?:better-sqlite3|node-pty)(?:\/|$)/u,
    /\/(?:\.ssh|test-results|coverage|\.git|\.cache)(?:\/|$)/u,
    /\/(?:authorized_keys|known_hosts|ssh_config|sshd_config)$/iu,
    /\/(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|identity)$/iu,
    /\/(?:ssh|ssh\.exe|plink|plink\.exe)$/iu,
    /\/(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc)$/iu,
    /\/(?:\.DS_Store|Thumbs\.db|npm-debug\.log|yarn-error\.log)$/iu,
  ];
  const packagedFilesystemEntries = (
    await packagedEntriesUnder(unpackedRoot)
  ).map((entry) => `/${entry}`);
  const unpackedAsarPrefix = "/resources/app.asar.unpacked";
  for (const entry of packagedFilesystemEntries) {
    const sedesIndex = entry.indexOf("/node_modules/@sedes/");
    if (sedesIndex === -1) continue;
    const virtualEntry = entry.slice(unpackedAsarPrefix.length);
    if (
      !entry.startsWith(`${unpackedAsarPrefix}/`) ||
      !allowedSedesEntries.has(virtualEntry)
    ) {
      throw new Error(
        `electron_packaged_unexpected_physical_sedes_entry:${entry}`,
      );
    }
  }
  for (const entry of [...applicationEntries, ...packagedFilesystemEntries]) {
    if (forbiddenEntryPatterns.some((pattern) => pattern.test(entry))) {
      throw new Error(`electron_packaged_forbidden_entry:${entry}`);
    }
  }

  const localServerEntries = await packagedEntriesUnder(localServerRoot);
  const localServerEntrySet = new Set(
    localServerEntries.map((entry) => entry.replaceAll("\\", "/")),
  );
  for (const required of [
    "package.json",
    "package-lock.json",
    "native-modules.json",
    "defaults/server.json",
    `protocol/codex-app-server/${codexVersion}/release.json`,
    "dist/server/index.js",
    "dist/client/index.html",
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  ]) {
    if (!localServerEntrySet.has(required)) {
      throw new Error(`electron_local_server_entry_missing:${required}`);
    }
  }
  const providerExecutablePackage = await findProviderExecutablePackage(
    path.join(localServerRoot, "node_modules"),
    "node_modules",
  );
  if (providerExecutablePackage) {
    throw new Error(
      `electron_local_server_provider_executable_present:${providerExecutablePackage}`,
    );
  }
  const managedLocalConfiguration = JSON.parse(
    await readFile(
      path.join(localServerRoot, "defaults", "server.json"),
      "utf8",
    ),
  );
  if (
    managedLocalConfiguration.schemaVersion !== 11 ||
    Object.keys(managedLocalConfiguration).some(key => !["schemaVersion", "packagedClients", "listen"].includes(key)) ||
    JSON.stringify(managedLocalConfiguration.packagedClients) !==
      JSON.stringify(["electron"])
  ) {
    throw new Error("electron_local_server_default_configuration_invalid");
  }
  const nativeManifest = JSON.parse(
    await readFile(path.join(localServerRoot, "native-modules.json"), "utf8"),
  );
  if (
    nativeManifest.platform !== process.platform ||
    nativeManifest.architecture !== process.arch ||
    !Array.isArray(nativeManifest.files) ||
    nativeManifest.files.length === 0
  ) {
    throw new Error("electron_local_server_native_manifest_invalid");
  }
  for (const filename of nativeManifest.files) {
    if (
      typeof filename !== "string" ||
      path.isAbsolute(filename) ||
      filename.split(/[\\/]/u).includes("..") ||
      !filename.endsWith(".node") ||
      !localServerEntrySet.has(filename.replaceAll("\\", "/"))
    ) {
      throw new Error(`electron_local_server_native_entry_invalid:${filename}`);
    }
  }
  for (const nativeSuffix of [
    `better-sqlite3/prebuilds/${betterSqlitePlatform()}-${process.arch}.node`,
    "node-pty/build/Release/pty.node",
  ]) {
    if (!nativeManifest.files.some((entry) => entry.endsWith(nativeSuffix))) {
      throw new Error(
        `electron_local_server_native_module_missing:${nativeSuffix}`,
      );
    }
  }
  for (const filename of nativeManifest.files) {
    if (
      (/better-sqlite3\/prebuilds\//u.test(filename) &&
        !filename.endsWith(`${betterSqlitePlatform()}-${process.arch}.node`)) ||
      (/node-pty\/prebuilds\/([^/]+)\//u.test(filename) &&
        !filename.includes(
          `/node-pty/prebuilds/${process.platform}-${process.arch}/`,
        )) ||
      (/pi-tui\/native\/([^/]+)\//u.test(filename) &&
        !filename.includes(
          `/pi-tui/native/${process.platform}/prebuilds/${process.platform}-${process.arch}/`,
        ))
    ) {
      throw new Error(`electron_local_server_foreign_native_entry:${filename}`);
    }
  }
  for (const forbidden of [
    /^\.git(?:\/|$)/u,
    /^(?:src|tests?|coverage|test-results)(?:\/|$)/u,
    /^node_modules\/(?:vitest|typescript|@playwright)(?:\/|$)/u,
    /\/(?:\.ssh|\.env(?:\.[^/]*)?|\.npmrc|\.netrc)(?:\/|$)/u,
  ]) {
    const match = localServerEntries.find((entry) =>
      forbidden.test(entry.replaceAll("\\", "/")),
    );
    if (match)
      throw new Error(`electron_local_server_forbidden_entry:${match}`);
  }
  if (process.platform !== "win32") {
    for (const [relative, expectedMode] of [
      ["dist/sidecar/manifest.json", 0o400],
      ["dist/sidecar/sedes", 0o500],
      ["dist/pi-sandbox-worker/manifest.json", 0o400],
      ["dist/pi-sandbox-worker/sedes-pi-sandbox-worker.mjs", 0o500],
      ["dist/claude-runtime-worker/manifest.json", 0o400],
      ["dist/claude-runtime-worker/sedes-claude-runtime-worker.mjs", 0o500],
    ]) {
      const metadata = await stat(path.join(localServerRoot, relative));
      if ((metadata.mode & 0o777) !== expectedMode) {
        throw new Error(`electron_local_server_mode_invalid:${relative}`);
      }
    }
  }
  process.stdout.write(
    `Electron packaged payload verified (${entries.length} ASAR entries, ${unpackedAsarEntries.length} unpacked ASAR files, ${packagedFilesystemEntries.length} packaged files, ${localServerEntries.length} managed Local files).\n`,
  );
}

if (mode === "--synced") await verifySynced();
else await verifyPackaged();
