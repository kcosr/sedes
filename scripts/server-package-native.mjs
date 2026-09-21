import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const targets = Object.freeze({
  'linux-x86_64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
  'macos-x86_64': { platform: 'darwin', arch: 'x64' },
  'macos-arm64': { platform: 'darwin', arch: 'arm64' },
});
export function assertBuildTarget(label, host = process) {
  const target = targets[label];
  if (!target || target.platform !== host.platform || target.arch !== host.arch) {
    throw new Error('Build on the selected target OS and architecture; cross-compilation is unsupported.');
  }
  const [major, minor, patch] = host.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && (minor < 18 || minor === 18 && patch < 0)) throw new Error('Node >=24.18.0 required');
  if (host.platform === 'linux' && !host.report.getReport().header.glibcVersionRuntime) throw new Error('Linux packages require glibc.');
  return { ...target, label };
}

export async function packageDirectories(modules) {
  const result = [];
  const entries = await readdir(modules, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(path.join(modules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) result.push(path.join(modules, entry.name, child.name));
      }
    } else result.push(path.join(modules, entry.name));
  }
  return result;
}

function matches(values, selected) {
  return !values || (!values.includes(`!${selected}`) && (values.every(value => value.startsWith('!')) || values.includes(selected) || values.includes('any')));
}

/** Pi 0.86 embeds all native targets inside one platform-neutral npm package. */
async function prunePiNativePayload(directory, manifest, target, removed) {
  if (manifest.version !== '0.86.0') throw new Error(`Unreviewed Pi native layout: ${manifest.version}`);
  const native = path.join(directory, 'native');
  for (const entry of await readdir(native, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === target.platform) continue;
    await rm(path.join(native, entry.name), { recursive: true });
    removed.push({ name: manifest.name, version: manifest.version, path: `native/${entry.name}` });
  }
  const prebuilds = path.join(native, target.platform, 'prebuilds');
  const selected = `${target.platform}-${target.arch}`;
  for (const entry of await readdir(prebuilds)) {
    if (entry === selected) continue;
    await rm(path.join(prebuilds, entry), { recursive: true });
    removed.push({ name: manifest.name, version: manifest.version, path: `native/${target.platform}/prebuilds/${entry}` });
  }
  // Keep the payload selected by Pi's dist/native-platform.js, including its
  // Linux X11 suffix. An upstream layout change requires a packaging review.
  const suffix = target.platform === 'linux' ? '-x11' : '';
  await readFile(path.join(prebuilds, selected, `${target.platform}-platform${suffix}.node`));
}

/** Enforce package-declared platform restrictions at every nesting level. */
export async function prunePlatformPackages(modules, target, removed = []) {
  for (const directory of await packageDirectories(modules)) {
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const forbidden = /^@anthropic-ai\/claude-agent-sdk-(linux|darwin|win32)-/.test(manifest.name);
    if (forbidden || !matches(manifest.os, target.platform) || !matches(manifest.cpu, target.arch) || !matches(manifest.libc, 'glibc')) {
      removed.push({ name: manifest.name, version: manifest.version });
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (manifest.name === '@openai/codex' || manifest.name.startsWith('@openai/codex-') || manifest.name === '@anthropic-ai/claude-code' || manifest.name.startsWith('@anthropic-ai/claude-code-') || manifest.name === 'electron' || manifest.name.startsWith('@capacitor/') || manifest.name === '@capawesome/capacitor-electron') throw new Error(`Forbidden runtime dependency: ${manifest.name}`);
    if (manifest.name === '@earendil-works/pi-tui') await prunePiNativePayload(directory, manifest, target, removed);
    await prunePlatformPackages(path.join(directory, 'node_modules'), target, removed);
  }
  return removed;
}

/** No install hooks or prebuild selection: rebuild the reviewed addons from source. */
export async function buildNativeAddons(repositoryRoot, stage, { nodedir, environment = process.env, run = execute } = {}) {
  const env = { ...environment, PATH: `${path.dirname(process.execPath)}${path.delimiter}${environment.PATH ?? ''}` };
  delete env.NODE_ENV;
  // Prevent ambient npm/Electron cross-build settings selecting a different ABI.
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key];
  const builds = [];
  for (const [name, version, outputs] of [
    ['better-sqlite3', '13.0.2', ['better_sqlite3.node']],
    ['node-pty', '1.1.0', process.platform === 'darwin' ? ['pty.node', 'spawn-helper'] : ['pty.node']],
  ]) {
    const directory = path.join(stage, 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`Unreviewed native dependency: ${name}@${manifest.version}`);
    await rm(path.join(directory, 'prebuilds'), { recursive: true, force: true });
    await rm(path.join(directory, 'build'), { recursive: true, force: true });
    const args = [path.join(repositoryRoot, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', '--release', '--force_build=1', `--target=${process.versions.node}`, `--arch=${process.arch}`];
    if (nodedir) args.push(`--nodedir=${path.resolve(nodedir)}`);
    await run(process.execPath, args, { cwd: directory, env, maxBuffer: 32 * 1024 * 1024 });
    for (const output of outputs) await readFile(path.join(directory, 'build/Release', output));
    // Keep only runtime outputs, never compiler objects or static SQLite archives.
    const keep = path.join(directory, '.sedes-native');
    await mkdir(keep);
    for (const output of outputs) await cp(path.join(directory, 'build/Release', output), path.join(keep, output));
    await rm(path.join(directory, 'build'), { recursive: true });
    await mkdir(path.join(directory, 'build/Release'), { recursive: true });
    for (const output of outputs) {
      await cp(path.join(keep, output), path.join(directory, 'build/Release', output));
      await chmod(path.join(directory, 'build/Release', output), 0o755);
    }
    await rm(keep, { recursive: true });
    // Sedes uses the operating system's ConPTY, never node-pty's optional
    // useConptyDll payload. Keep generated runtime outputs, not vendor DLLs.
    await rm(path.join(directory, 'third_party'), { recursive: true, force: true });
    // Sidecar collection uses this ABI declaration for the freshly built Linux addon.
    if (name === 'node-pty') {
      const native = path.join(directory, 'prebuilds', `${process.platform}-${process.arch}`);
      await mkdir(native, { recursive: true });
      for (const output of outputs) await cp(path.join(directory, 'build/Release', output), path.join(native, output));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(native, 'sidecar-native.json'), JSON.stringify({ nodeModuleVersion: process.versions.modules }));
    }
    builds.push({ name, version, command: [process.execPath, ...args], outputs });
  }
  return builds;
}
