import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { inspectSidecarPortableNative } from "./sidecar-native-portable.mjs";
import { inspectSidecarNativeElf } from "./sidecar-native-elf.mjs";

const architectures = Object.freeze(["x64", "arm64"]);

/**
 * Collect reviewed platform-specific node-pty payloads. Version 1.1.0 ships no Linux
 * prebuilds: npm builds the current host's addon. A cross-host artifact must
 * be supplied in prebuilds/linux-ARCH with sidecar-native.json containing its
 * nodeModuleVersion. Missing architectures are unavailable, never substituted.
 * sources is build-only; serialize only nativeAssets into the release manifest.
 */
export async function collectSidecarNativeArtifacts({ nodePtyRoot }) {
  const root = await realpath(nodePtyRoot);
  const metadata = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (metadata.name !== "node-pty" || metadata.version !== "1.1.0") {
    throw new Error("sidecar_native_dependency_unreviewed");
  }
  const nativeAssets = [];
  const sources = [];
  for (const architecture of architectures) {
    const prebuildRoot = path.join(root, "prebuilds", `linux-${architecture}`);
    let sourcePath = path.join(prebuildRoot, "pty.node");
    let contents = await readNative(sourcePath, root);
    let nodeModuleVersion;
    if (contents !== undefined) {
      const declaration = JSON.parse(
        await readFile(path.join(prebuildRoot, "sidecar-native.json"), "utf8"),
      );
      nodeModuleVersion = declaration.nodeModuleVersion;
    } else if (process.platform === "linux" && process.arch === architecture) {
      sourcePath = path.join(root, "build", "Release", "pty.node");
      contents = await readNative(sourcePath, root);
      if (contents !== undefined) {
        const configuration = JSON.parse(
          (await readFile(path.join(root, "build", "config.gypi"), "utf8"))
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("#"))
            .join("\n"),
        );
        if (
          configuration.variables?.target_arch !== architecture ||
          !Number.isSafeInteger(configuration.variables?.node_module_version)
        ) {
          throw new Error("sidecar_native_build_metadata_invalid");
        }
        nodeModuleVersion = String(configuration.variables.node_module_version);
      }
    }
    if (contents === undefined) continue;
    if (
      typeof nodeModuleVersion !== "string" ||
      !/^[1-9][0-9]{0,3}$/u.test(nodeModuleVersion)
    ) {
      throw new Error("sidecar_native_node_version_invalid");
    }
    const { minimumGlibcVersion } = inspectSidecarNativeElf(
      contents,
      architecture,
    );
    const relativePath = `native/linux-${architecture}/pty.node`;
    const file = {
      relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
      mode: 0o500,
    };
    nativeAssets.push({
      platform: "linux",
      architecture,
      nodeModuleVersion,
      minimumGlibcVersion,
      files: [file],
    });
    sources.push({ relativePath, sourcePath, contents });
  }
  for (const platform of ["darwin", "win32"]) {
    for (const architecture of architectures) {
      const prebuildRoot = path.join(
        root,
        "prebuilds",
        `${platform}-${architecture}`,
      );
      const names =
        platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : ["conpty.node", "conpty_console_list.node"];
      const entries = [];
      let nodeApiVersion;
      for (const name of names) {
        const sourcePath = path.join(prebuildRoot, name);
        const contents = await readNative(sourcePath, root);
        if (contents === undefined) {
          if (entries.length)
            throw new Error("sidecar_native_payload_incomplete");
          break;
        }
        const inspected = inspectSidecarPortableNative(
          contents,
          platform,
          architecture,
          name.endsWith(".node"),
        );
        if (inspected.nodeApiVersion !== undefined) {
          if (
            nodeApiVersion !== undefined &&
            inspected.nodeApiVersion !== nodeApiVersion
          )
            throw new Error("sidecar_native_node_version_invalid");
          nodeApiVersion = inspected.nodeApiVersion;
        }
        entries.push({ name, sourcePath, contents });
      }
      if (!entries.length) continue;
      if (platform === "win32") {
        const workerSource = path.join(
          root,
          "lib",
          "worker",
          "conoutSocketWorker.js",
        );
        const worker = await build({
          entryPoints: [workerSource],
          bundle: true,
          platform: "node",
          format: "cjs",
          write: false,
          legalComments: "none",
        });
        entries.push({
          name: "conout-worker.cjs",
          sourcePath: workerSource,
          contents: worker.outputFiles[0].contents,
        });
        const native = entries.find(
          (entry) => entry.name === "conpty_console_list.node",
        );
        const digest = createHash("sha256")
          .update(native.contents)
          .digest("hex");
        const agent = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const filename=path.join(__dirname,'conpty_console_list.node');const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==${JSON.stringify(digest)})throw new Error('sidecar_native_digest_mismatch');const consoleProcessList=require(filename).getConsoleProcessList(Number(process.argv[2]));process.send({consoleProcessList});process.exit(0);\n`;
        entries.push({
          name: "console-list-agent.cjs",
          sourcePath: path.join(root, "lib", "conpty_console_list_agent.js"),
          contents: Buffer.from(agent),
        });
      }
      const files = entries.map((entry) => ({
        relativePath: `native/${platform}-${architecture}/${entry.name}`,
        sha256: createHash("sha256").update(entry.contents).digest("hex"),
        size: entry.contents.byteLength,
        mode: 0o500,
      }));
      nativeAssets.push({ platform, architecture, nodeApiVersion, files });
      entries.forEach((entry, index) =>
        sources.push({
          relativePath: files[index].relativePath,
          sourcePath: entry.sourcePath,
          contents: entry.contents,
        }),
      );
    }
  }
  return { nativeAssets, sources };
}

async function readNative(filename, root) {
  let canonical;
  try {
    canonical = await realpath(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (canonical !== filename || !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error("sidecar_native_source_invalid");
  }
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 64 ||
      metadata.size > 32 * 1024 * 1024
    ) {
      throw new Error("sidecar_native_source_invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Bundle node-pty with one adjacent, verified native path; never search cwd. */
export function sidecarNodePtyPlugin(nativeAssets) {
  for (const asset of nativeAssets) {
    const names =
      asset.platform === "linux"
        ? ["pty.node"]
        : asset.platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : asset.platform === "win32"
            ? [
                "conpty.node",
                "conpty_console_list.node",
                "conout-worker.cjs",
                "console-list-agent.cjs",
              ]
            : [];
    if (
      !names.length ||
      !architectures.includes(asset.architecture) ||
      (asset.platform === "linux"
        ? typeof asset.nodeModuleVersion !== "string" ||
          !/^[1-9][0-9]{0,3}$/u.test(asset.nodeModuleVersion) ||
          typeof asset.minimumGlibcVersion !== "string" ||
          !/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(asset.minimumGlibcVersion)
        : !Number.isSafeInteger(asset.nodeApiVersion) ||
          asset.nodeApiVersion < 1 ||
          asset.nodeApiVersion > 10) ||
      !Array.isArray(asset.files) ||
      asset.files.length !== names.length ||
      asset.files.some(
        (file, index) =>
          file.relativePath !==
            `native/${asset.platform}-${asset.architecture}/${names[index]}` ||
          !/^[0-9a-f]{64}$/u.test(file.sha256) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 64 ||
          file.size > 32 * 1024 * 1024 ||
          file.mode !== 0o500,
      )
    )
      throw new Error("sidecar_native_manifest_invalid");
  }
  if (
    new Set(
      nativeAssets.map((asset) => `${asset.platform}-${asset.architecture}`),
    ).size !== nativeAssets.length
  )
    throw new Error("sidecar_native_manifest_invalid");
  return {
    name: "sedes-sidecar-node-pty",
    setup(build) {
      // Windows node-pty normally defers addon loading until spawn. Admission
      // probes must fail before advertising a terminal capability without it.
      build.onLoad(
        { filter: /[/\\]node-pty[/\\]lib[/\\]index\.js$/ },
        async ({ path: filename }) => ({
          loader: "js",
          contents:
            "if (process.platform === 'win32') require('./utils').loadNativeModule('conpty');\n" +
            (await readFile(filename, "utf8")),
        }),
      );
      build.onLoad(
        { filter: /[/\\]node-pty[/\\]lib[/\\]windowsConoutConnection\.js$/ },
        async ({ path: filename }) => ({
          loader: "js",
          contents: (await readFile(filename, "utf8")).replace(
            "path_1.join(scriptPath, 'worker/conoutSocketWorker.js')",
            "require('./utils').getHelperPath('conout-worker.cjs')",
          ),
        }),
      );
      build.onLoad(
        { filter: /[/\\]node-pty[/\\]lib[/\\]windowsPtyAgent\.js$/ },
        async ({ path: filename }) => ({
          loader: "js",
          contents: (await readFile(filename, "utf8")).replace(
            "path.join(__dirname, 'conpty_console_list_agent')",
            "utils_1.getHelperPath('console-list-agent.cjs')",
          ),
        }),
      );
      build.onLoad({ filter: /[/\\]node-pty[/\\]lib[/\\]utils\.js$/ }, () => ({
        loader: "js",
        contents: `
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const assets = ${JSON.stringify(nativeAssets)};
export function assign(target, ...sources) {
  for (const source of sources) for (const key of Object.keys(source)) target[key] = source[key];
  return target;
}
function verifyAsset() {
  const asset = assets.find(item => item.platform === process.platform && item.architecture === process.arch);
  if (!asset) throw new Error('sidecar_native_platform_unavailable');
  if (asset.platform === 'win32' && Number(release().split('.')[2] ?? 0) < 18309) throw new Error('sidecar_native_windows_version_unsupported');
  if (asset.platform === 'linux' && asset.nodeModuleVersion !== process.versions.modules) throw new Error('sidecar_native_node_version_mismatch');
  if (asset.platform !== 'linux' && Number(process.versions.napi ?? 0) < asset.nodeApiVersion) throw new Error('sidecar_native_node_api_version_mismatch');
  if (asset.platform === 'linux') {
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  const required = asset.minimumGlibcVersion.split('.').map(Number);
  const actual = typeof glibc === 'string' ? glibc.split('.').map(Number) : [];
  let compatible = actual.length > 0;
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    if ((actual[index] ?? 0) > (required[index] ?? 0)) break;
    if ((actual[index] ?? 0) < (required[index] ?? 0)) { compatible = false; break; }
  }
  if (!compatible) throw new Error('sidecar_native_glibc_version_mismatch');
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  for (const relative of ['native', 'native/' + asset.platform + '-' + process.arch]) {
    const directory = lstatSync(path.join(root, relative));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('sidecar_native_directory_invalid');
  }
  for (const file of asset.files) {
  const filename = path.join(root, file.relativePath);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size ||
      (process.platform !== 'win32' && ((metadata.mode & 0o777) !== file.mode || metadata.uid !== process.getuid()))) {
    throw new Error('sidecar_native_file_invalid');
  }
  if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== file.sha256) {
    throw new Error('sidecar_native_digest_mismatch');
  }
  }
  return {asset, root};
}
export function getHelperPath(name) {
  const {asset, root} = verifyAsset();
  const file = asset.files.find(file => file.relativePath.endsWith('/' + name));
  if (!file || !['conout-worker.cjs', 'console-list-agent.cjs'].includes(name)) throw new Error('sidecar_native_helper_unavailable');
  return path.join(root, file.relativePath);
}
export function loadNativeModule(name) {
  const {asset, root} = verifyAsset();
  const allowed = asset.platform === 'win32' ? ['conpty', 'conpty_console_list'] : ['pty'];
  if (!allowed.includes(name)) throw new Error('sidecar_native_platform_unavailable');
  const file = asset.files.find(file => file.relativePath.endsWith('/' + name + '.node'));
  const filename = path.join(root, file.relativePath);
  return {dir: path.dirname(filename), module: createRequire(import.meta.url)(filename)};
}
`,
      }));
    },
  };
}
