import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertServerRuntimeBoundary } from './check-server-runtime.mjs';
import { prunePlatformPackages } from './server-package-native.mjs';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function electronNativeOutputs(platform) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('electron_native_platform_unsupported');
  return {
    'better-sqlite3': ['better_sqlite3.node'],
    'node-pty': platform === 'win32'
      ? ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll']
      : ['pty.node', ...(platform === 'darwin' ? ['spawn-helper'] : [])],
  };
}

/** Remove preferred upstream prebuilds before invoking Electron's source builder. */
export async function rebuildElectronNativeAddons(stage, { electronVersion, rebuild, platform = process.platform, arch = process.arch }) {
  const versions = { 'better-sqlite3': '13.0.2', 'node-pty': '1.1.0' };
  const outputs = electronNativeOutputs(platform);
  for (const [name, version] of Object.entries(versions)) {
    const directory = path.join(stage, 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`electron_native_version_unreviewed:${name}@${manifest.version}`);
    await rm(path.join(directory, 'prebuilds'), { recursive: true, force: true });
    await rm(path.join(directory, 'build'), { recursive: true, force: true });
  }
  await rebuild({ buildPath: stage, electronVersion, platform, arch, force: true, buildFromSource: true, onlyModules: Object.keys(outputs), mode: 'sequential', types: ['prod', 'optional'] });
  for (const [name, files] of Object.entries(outputs)) {
    const directory = path.join(stage, 'node_modules', name);
    const retained = path.join(directory, '.sedes-native');
    await mkdir(retained);
    for (const filename of files) await cp(path.join(directory, 'build/Release', filename), path.join(retained, filename));
    await rm(path.join(directory, 'build'), { recursive: true });
    await mkdir(path.join(directory, 'build/Release'), { recursive: true });
    for (const filename of files) {
      await cp(path.join(retained, filename), path.join(directory, 'build/Release', filename));
      if (platform !== 'win32') await chmod(path.join(directory, 'build/Release', filename), 0o755);
    }
    await rm(retained, { recursive: true });
    for (const relative of ['prebuilds', 'src', 'deps', 'binding.gyp']) await rm(path.join(directory, relative), { recursive: true, force: true });
  }
}

async function nativeFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await nativeFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.node')) files.push(relative);
  }
  return files.sort();
}

export async function prepareElectronLocalServer() {
  const electronRoot = path.join(repositoryRoot, 'electron');
  const stage = path.join(electronRoot, 'generated/local-server');
  const distribution = JSON.parse(await readFile(path.join(electronRoot, 'generated/distribution.json'), 'utf8'));
  if (Object.keys(distribution).length !== 1 || distribution.profile !== 'full') throw new Error('electron_local_server_requires_full_profile');
  const dist = path.join(repositoryRoot, 'dist');
  if (!(await stat(path.join(dist, 'server/index.js'))).isFile()) throw new Error('electron_local_server_build_missing');
  await assertServerRuntimeBoundary({ repositoryRoot, distRoot: dist });
  const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const codexVersion = rootManifest.devDependencies['@openai/codex'];
  if (!/^\d+\.\d+\.\d+$/u.test(codexVersion)) throw new Error('electron_local_server_codex_version_invalid');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const filename of ['package.json', 'package-lock.json']) await cp(path.join(repositoryRoot, 'packages/server-runtime', filename), path.join(stage, filename));
  const environment = { ...process.env };
  delete environment.NODE_ENV;
  for (const key of Object.keys(environment)) if (/^npm_config_/i.test(key)) delete environment[key];
  const npmPath = process.env.npm_execpath;
  if (process.platform === 'win32' && !npmPath) throw new Error('Run Electron preparation through an npm script on Windows.');
  const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  await execute(npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...npmArgs] : npmArgs, { cwd: stage, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const removedPackages = await prunePlatformPackages(path.join(stage, 'node_modules'), { platform: process.platform, arch: process.arch });
  const electronManifest = JSON.parse(await readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  const electronVersion = electronManifest.devDependencies.electron;
  const requireElectron = createRequire(path.join(electronRoot, 'package.json'));
  const { rebuild } = await import(pathToFileURL(requireElectron.resolve('@electron/rebuild')).href);
  await rebuildElectronNativeAddons(stage, { electronVersion, rebuild });
  await cp(dist, path.join(stage, 'dist'), { recursive: true, filter: source => !source.endsWith('.map') && !source.endsWith('.test.js') });
  const configuration = JSON.parse(await readFile(path.join(repositoryRoot, 'config/server.example.json'), 'utf8'));
  if (configuration.schemaVersion !== 11 || Object.keys(configuration).some(key => !['schemaVersion', 'packagedClients', 'listen'].includes(key)) || !Array.isArray(configuration.packagedClients) || configuration.packagedClients.length !== 0) throw new Error('electron_local_server_default_configuration_invalid');
  await mkdir(path.join(stage, 'defaults'));
  await writeFile(path.join(stage, 'defaults/server.json'), JSON.stringify({ ...configuration, packagedClients: ['electron'] }, null, 2) + '\n');
  const release = `protocol/codex-app-server/${codexVersion}/release.json`;
  await mkdir(path.dirname(path.join(stage, release)), { recursive: true });
  await cp(path.join(repositoryRoot, release), path.join(stage, release));
  const files = await nativeFiles(stage);
  await writeFile(path.join(stage, 'native-modules.json'), JSON.stringify({ platform: process.platform, architecture: process.arch, electronVersion, builtFromSource: true, files, removedPackages }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareElectronLocalServer();
  console.log('Electron full server staged with target runtime dependencies and source-built addons.');
}
