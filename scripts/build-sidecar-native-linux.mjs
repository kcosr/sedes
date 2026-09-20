import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  compareVersions,
  inspectSidecarNativeElf,
} from "./sidecar-native-elf.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** Compile against a supplied Rocky 8 sysroot; never relabel host-linked code. */
export async function buildSidecarNativeLinux({
  sysroot,
  nodeHeaders,
  compiler = "clang++",
  outputDirectory,
}) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("sidecar_native_build_host_unsupported");
  const root = await realpath(sysroot);
  const headers = await realpath(nodeHeaders);
  const nodePtyRoot = path.dirname(require.resolve("node-pty/package.json"));
  const dependency = JSON.parse(
    await readFile(path.join(nodePtyRoot, "package.json"), "utf8"),
  );
  if (dependency.version !== "1.1.0")
    throw new Error("sidecar_native_dependency_unreviewed");
  const nodeModuleVersion = (
    await readFile(path.join(headers, "node_version.h"), "utf8")
  ).match(/^#define NODE_MODULE_VERSION\s+([0-9]+)$/mu)?.[1];
  if (!nodeModuleVersion || nodeModuleVersion !== process.versions.modules)
    throw new Error("sidecar_native_build_headers_mismatch");
  const gcc = path.join(root, "usr/lib/gcc/x86_64-redhat-linux/8");
  const cxx = path.join(root, "usr/include/c++/8");
  // Resolve the actual files before invoking the linker. Sysroot symlinks must
  // stay inside it; an absolute host-library link would defeat portability.
  const required = [
    "usr/include/features.h",
    "usr/include/pty.h",
    "usr/include/linux/types.h",
    "usr/lib64/crti.o",
    "usr/lib64/crtn.o",
    "usr/lib64/libc.so",
    "usr/lib64/libutil.so",
    "usr/lib64/libpthread.so",
    "usr/lib64/libm.so",
    "usr/lib64/libstdc++.so.6",
    "lib64/libgcc_s.so.1",
    "usr/lib/gcc/x86_64-redhat-linux/8/crtbeginS.o",
    "usr/lib/gcc/x86_64-redhat-linux/8/crtendS.o",
    "usr/lib/gcc/x86_64-redhat-linux/8/libgcc.a",
    "usr/include/c++/8/vector",
    "usr/include/c++/8/x86_64-redhat-linux/bits/c++config.h",
  ];
  for (const relative of required) {
    const canonical = await realpath(path.join(root, relative));
    if (!canonical.startsWith(`${root}${path.sep}`))
      throw new Error("sidecar_native_sysroot_escape");
  }
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: "0",
  };
  const options = {
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  };
  const resource = (
    await run(compiler, ["-print-resource-dir"], options)
  ).stdout.trim();
  const compilerVersion = (
    await run(compiler, ["--version"], options)
  ).stdout.trim();
  const output = path.resolve(
    outputDirectory ?? path.join(nodePtyRoot, "prebuilds/linux-x64"),
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(output, ".build-"));
  try {
    const artifactPath = path.join(staging, "pty.node");
    const arguments_ = [
      "--target=x86_64-linux-gnu",
      `--sysroot=${root}`,
      "-std=gnu++20",
      "-nostdinc",
      "-nostdinc++",
      "-nostdlib",
      "-shared",
      "-fPIC",
      "-pthread",
      "-O2",
      "-fno-omit-frame-pointer",
      "-fno-rtti",
      "-fno-strict-aliasing",
      "-D_FORTIFY_SOURCE=2",
      "-D_FILE_OFFSET_BITS=64",
      "-D_LARGEFILE_SOURCE",
      "-DNODE_GYP_MODULE_NAME=pty",
      "-DNAPI_CPP_EXCEPTIONS",
      "-DBUILDING_NODE_EXTENSION",
      `-ffile-prefix-map=${nodePtyRoot}=node-pty`,
      `-ffile-prefix-map=${headers}=node-headers`,
      `-ffile-prefix-map=${root}=sysroot`,
      "-isystem",
      cxx,
      "-isystem",
      path.join(cxx, "x86_64-redhat-linux"),
      "-isystem",
      path.join(cxx, "backward"),
      "-isystem",
      path.join(resource, "include"),
      "-isystem",
      path.join(root, "usr/include"),
      "-I",
      headers,
      "-I",
      path.join(nodePtyRoot, "node_modules/node-addon-api"),
      path.join(root, "usr/lib64/crti.o"),
      path.join(gcc, "crtbeginS.o"),
      path.join(nodePtyRoot, "src/unix/pty.cc"),
      "-L",
      gcc,
      "-L",
      path.join(root, "usr/lib64"),
      "-L",
      path.join(root, "lib64"),
      "-Wl,--build-id=sha1",
      "-Wl,-z,relro,-z,now",
      "-l:libstdc++.so.6",
      "-lm",
      "-lgcc_s",
      "-lgcc",
      "-lc",
      "-lpthread",
      "-lutil",
      path.join(gcc, "crtendS.o"),
      path.join(root, "usr/lib64/crtn.o"),
      "-o",
      artifactPath,
    ];
    await run(compiler, arguments_, options);
    const contents = await readFile(artifactPath);
    const { minimumGlibcVersion } = inspectSidecarNativeElf(contents, "x64");
    if (compareVersions(minimumGlibcVersion, "2.28") > 0)
      throw new Error("sidecar_native_build_glibc_too_new");
    const probe = `
const pty = require(process.argv[1]);
const fs = require('node:fs');
const pair = pty.open(80, 24);
try { pty.resize(pair.master, 100, 30); } finally { fs.closeSync(pair.master); fs.closeSync(pair.slave); }
`;
    await run(
      process.execPath,
      ["--input-type=commonjs", "-e", probe, artifactPath],
      options,
    );
    // Run the real baseline loader/libc/libstdc++ without chroot or changing
    // host libraries. The build Node binary must itself support glibc 2.28.
    await run(
      path.join(root, "lib64/ld-linux-x86-64.so.2"),
      [
        "--library-path",
        `${path.join(root, "usr/lib64")}:${path.join(root, "lib64")}`,
        process.execPath,
        "--input-type=commonjs",
        "-e",
        "if(process.report.getReport().header.glibcVersionRuntime!=='2.28')throw new Error('sidecar_native_verification_libc_mismatch');" +
          probe,
        artifactPath,
      ],
      options,
    );
    const declaration = { nodeModuleVersion };
    const provenance = {
      nodePtyVersion: dependency.version,
      platform: "linux",
      architecture: "x64",
      nodeModuleVersion,
      minimumGlibcVersion,
      verifiedGlibcRuntime: "2.28",
      compilerVersion,
      sha256: createHash("sha256").update(contents).digest("hex"),
      sourceSha256: createHash("sha256")
        .update(await readFile(path.join(nodePtyRoot, "src/unix/pty.cc")))
        .digest("hex"),
      sysrootFeaturesSha256: createHash("sha256")
        .update(await readFile(path.join(root, "usr/include/features.h")))
        .digest("hex"),
    };
    await writeFile(
      path.join(staging, "sidecar-native.json"),
      `${JSON.stringify(declaration, null, 2)}\n`,
      { mode: 0o400 },
    );
    await writeFile(
      path.join(staging, "build-info.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { mode: 0o400 },
    );
    await chmod(artifactPath, 0o500);
    for (const filename of [
      "pty.node",
      "sidecar-native.json",
      "build-info.json",
    ])
      await rename(path.join(staging, filename), path.join(output, filename));
    return { outputDirectory: output, ...provenance };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {};
  const keys = {
    "--sysroot": "sysroot",
    "--node-headers": "nodeHeaders",
    "--compiler": "compiler",
    "--output-directory": "outputDirectory",
  };
  const arguments_ = process.argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = keys[arguments_[index]];
    if (!key || !arguments_[index + 1] || options[key])
      throw new Error("sidecar_native_build_arguments_invalid");
    options[key] = arguments_[index + 1];
  }
  if (!options.sysroot || !options.nodeHeaders)
    throw new Error(
      "Usage: node scripts/build-sidecar-native-linux.mjs --sysroot /absolute/rocky8-root --node-headers /absolute/node/include/node",
    );
  process.stdout.write(
    `${JSON.stringify(await buildSidecarNativeLinux(options), null, 2)}\n`,
  );
}
