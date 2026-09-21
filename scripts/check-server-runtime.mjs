import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `internal` enters the TypeScript output through relative server imports.
const sourceDirectories = ["server", "cli", "shared", "internal"];
const piImageModule = "server/backends/pi/pi-remote-image-processing";
const piPackage = "@earendil-works/pi-coding-agent";

function literalString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function packageName(specifier) {
  if (isBuiltin(specifier) || specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (specifier.includes(":") || specifier.startsWith("#")) throw new Error(`server_runtime_unsupported_specifier:${specifier}`);
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
}

/** Parse executable JS, never strings/comments or erased TypeScript imports. */
export function discoverJavaScriptPackages(source, relativePath) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const packages = new Set();
  const computed = [];
  let piAnchor = false;
  let piImagePath = false;
  const include = (argument, node) => {
    const specifier = literalString(argument);
    if (specifier === undefined) { computed.push({ argument, node }); return; }
    const name = packageName(specifier);
    if (name) packages.add(name);
  };
  walk(ast, (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) include(node.source, node);
    if (node.type === "ImportExpression") include(node.source, node);
    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "Identifier" && callee.name === "require") include(node.arguments[0], node);
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.name === "resolve") {
        const object = callee.object;
        if ((object.type === "Identifier" && object.name === "require") || object.type === "MetaProperty" && object.meta.name === "import") {
          include(node.arguments[0], node);
          if (object.type === "MetaProperty" && literalString(node.arguments[0]) === piPackage) piAnchor = true;
        }
      }
    }
    if (node.type === "NewExpression" && node.callee.name === "URL" && literalString(node.arguments[0]) === "./utils/image-process.js" && node.arguments[1]?.name === "packageEntry") piImagePath = true;
  });
  for (const { argument, node } of computed) {
    // Pi's public export map omits this pinned internal image utility. Its only
    // computed import is rooted in an explicit package resolution above; fail
    // closed if that source contract changes or another dynamic load appears.
    const expectedPiImport = relativePath.replace(/\.(?:ts|js)$/u, "") === piImageModule
      && node.type === "ImportExpression" && argument.type === "MemberExpression"
      && !argument.computed && argument.object.name === "moduleUrl"
      && argument.property.name === "href" && piAnchor && piImagePath && computed.length === 1;
    if (!expectedPiImport) throw new Error(`server_runtime_computed_import_unreviewed:${relativePath}:${node.start}`);
  }
  return [...packages].sort();
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files.sort();
}

export async function discoverRuntimePackages(baseDirectory, { typescript = false } = {}) {
  const found = new Map();
  for (const directory of sourceDirectories) {
    for (const filename of await filesUnder(path.join(baseDirectory, directory))) {
      if (!filename.endsWith(typescript ? ".ts" : ".js") || /\.(?:test|d)\.ts$/u.test(filename) || filename.endsWith(".test.js")) continue;
      const relativePath = path.relative(baseDirectory, filename).split(path.sep).join("/");
      let source = await readFile(filename, "utf8");
      if (typescript) source = (await transform(source, { loader: "ts", target: "esnext", format: "esm" })).code;
      for (const name of discoverJavaScriptPackages(source, relativePath)) {
        if (!found.has(name)) found.set(name, []);
        found.get(name).push(relativePath);
      }
    }
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
}

export function assertRuntimeManifest({ rootManifest, runtimeManifest, lock, discovered }) {
  const dependencies = runtimeManifest.dependencies ?? {};
  const missing = Object.keys(discovered).filter(name => !(name in dependencies));
  const unused = Object.keys(dependencies).filter(name => !(name in discovered));
  if (missing.length || unused.length) throw new Error(`server_runtime_dependency_boundary:missing=${missing.join(",")};unused=${unused.join(",")}`);
  if (runtimeManifest.devDependencies || runtimeManifest.optionalDependencies) throw new Error("server_runtime_manifest_must_only_have_runtime_dependencies");
  if (runtimeManifest.version !== rootManifest.version || runtimeManifest.engines?.node !== ">=24.18.0") throw new Error("server_runtime_manifest_metadata_drift");
  if (lock.lockfileVersion !== 3 || lock.name !== runtimeManifest.name || lock.version !== runtimeManifest.version || lock.packages?.[""]?.name !== runtimeManifest.name || lock.packages?.[""]?.version !== runtimeManifest.version) throw new Error("server_runtime_lock_metadata_drift");
  if (JSON.stringify(lock.packages[""].dependencies) !== JSON.stringify(dependencies)) throw new Error("server_runtime_lock_dependencies_drift");
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || rootManifest.dependencies?.[name] !== version || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`server_runtime_dependency_version_drift:${name}`);
  }
}

/** Packaging supplies distRoot after build to check emitted imports as well. */
export async function assertServerRuntimeBoundary({ repositoryRoot = root, distRoot } = {}) {
  const json = async file => JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8"));
  const [rootManifest, runtimeManifest, lock, discovered] = await Promise.all([
    json("package.json"), json("packages/server-runtime/package.json"), json("packages/server-runtime/package-lock.json"),
    discoverRuntimePackages(path.join(repositoryRoot, "src"), { typescript: true }),
  ]);
  assertRuntimeManifest({ rootManifest, runtimeManifest, lock, discovered });
  if (distRoot) {
    const emitted = await discoverRuntimePackages(distRoot);
    assertRuntimeManifest({ rootManifest, runtimeManifest, lock, discovered: emitted });
  }
  return { runtimeManifest, discovered };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--dist")) throw new Error("Usage: node scripts/check-server-runtime.mjs [--dist]");
  const result = await assertServerRuntimeBoundary({ distRoot: args.length ? path.join(root, "dist") : undefined });
  process.stdout.write(`Server runtime boundary verified: ${Object.keys(result.discovered).length} direct dependencies.\n`);
}
