#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseElectronDistributionArguments(args) {
  const [command, ...rest] = args;
  if (!['sync', 'package', 'verify'].includes(command)) throw new Error('Expected sync, package, or verify');
  let profile = 'full';
  let directory = false;
  let profileProvided = false;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--profile' && !profileProvided && ['client', 'full'].includes(rest[index + 1])) {
      profile = rest[++index]; profileProvided = true;
    } else if (rest[index] === '--dir' && command === 'package' && !directory) directory = true;
    else throw new Error('Usage: electron-distribution.mjs sync|package|verify [--profile client|full] [--dir (package only)]');
  }
  return { command, profile, directory };
}

export async function writeElectronDistribution(directory, profile) {
  if (!['client', 'full'].includes(profile)) throw new Error('electron_distribution_profile_invalid');
  await mkdir(path.join(directory, 'generated'), { recursive: true });
  // Remove the previous full payload before either profile is staged. A client
  // build must never retain a prior full runtime, even in the source project.
  await rm(path.join(directory, 'generated/local-server'), { recursive: true, force: true });
  await writeFile(path.join(directory, 'generated/distribution.json'), JSON.stringify({ profile }) + '\n');
}

/** Never associate an earlier installer with the current build's provenance. */
export async function prepareElectronOutputDirectory(electronRoot, profile) {
  if (!['client', 'full'].includes(profile)) throw new Error('electron_distribution_profile_invalid');
  const dist = path.join(electronRoot, 'dist');
  const output = path.join(dist, profile);
  await mkdir(dist, { recursive: true });
  const existing = await lstat(output).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  let previous;
  if (existing) {
    if (!existing.isDirectory()) throw new Error('electron_distribution_output_not_directory');
    const preserved = await mkdtemp(path.join(dist, `previous-${profile}-`));
    previous = path.join(preserved, profile);
    await rename(output, previous);
  }
  await mkdir(output);
  return { output, previous };
}

export async function writeElectronOutputProvenance(output, info) {
  const sums = [];
  const symlinks = {};
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && ['SHA256SUMS', 'BUILD-INFO.json'].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(filename, relative);
      else if (entry.isSymbolicLink()) symlinks[relative] = await readlink(filename);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(filename)) hash.update(chunk);
        sums.push(`${hash.digest('hex')}  ${relative}`);
      } else throw new Error(`Unsupported Electron output entry: ${relative}`);
    }
  }
  await collect(output);
  const metadata = JSON.stringify({ ...info, symlinks, packagedAt: new Date().toISOString() }, null, 2) + '\n';
  await writeFile(path.join(output, 'BUILD-INFO.json'), metadata);
  sums.push(`${createHash('sha256').update(metadata).digest('hex')}  BUILD-INFO.json`);
  await writeFile(path.join(output, 'SHA256SUMS'), sums.sort().join('\n') + '\n');
}

function run(command, args, cwd, env, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

export async function runElectronDistribution(options) {
  const electron = path.join(root, 'electron');
  const env = { ...process.env };
  delete env.NODE_ENV;
  const node = (args, cwd = root, extra) => run(process.execPath, args, cwd, env, extra);
  const npmPath = process.env.npm_execpath;
  if (process.platform === 'win32' && !npmPath) throw new Error('Run Electron packaging through npm run electron:package on Windows.');
  const npm = (args, cwd = root) => npmPath ? node([npmPath, ...args], cwd) : run('npm', args, cwd, env);
  await npm(['ci'], electron);
  if (options.profile === 'full') await npm(['run', 'build']);
  else await node(['node_modules/vite/bin/vite.js', 'build']);
  await node(['node_modules/@capacitor/cli/bin/capacitor', 'sync', '@capawesome/capacitor-electron']);
  await writeElectronDistribution(electron, options.profile);
  for (const filename of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(path.join(root, filename), path.join(electron, 'generated', filename));
  if (options.profile === 'full') await node(['scripts/prepare-electron-local-server.mjs']);
  const [manifest, electronManifest] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(electron, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const sourceCommit = await run('git', ['rev-parse', 'HEAD'], root, env, { capture: true });
  const sourceBranch = await run('git', ['branch', '--show-current'], root, env, { capture: true });
  const sourceCommitTimestamp = await run('git', ['show', '-s', '--format=%cI', 'HEAD'], root, env, { capture: true });
  const dirty = Boolean(await run('git', ['status', '--porcelain'], root, env, { capture: true }));
  const requireElectron = createRequire(path.join(electron, 'package.json'));
  const { getAbi } = await import(pathToFileURL(requireElectron.resolve('node-abi')).href);
  const locks = {};
  for (const filename of ['package-lock.json', 'electron/package-lock.json', 'packages/server-runtime/package-lock.json']) locks[filename] = createHash('sha256').update(await readFile(path.join(root, filename))).digest('hex');
  const info = {
    format: 1, profile: options.profile, version: manifest.version,
    sourceCommit, sourceBranch: sourceBranch || null, sourceCommitTimestamp: new Date(sourceCommitTimestamp).toISOString(),
    dirty, platform: process.platform, architecture: process.arch,
    host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), glibc: process.report.getReport().header.glibcVersionRuntime ?? null },
    electron: { version: electronManifest.devDependencies.electron, abi: getAbi(electronManifest.devDependencies.electron, 'electron') },
    buildNode: process.version, dependencyLockSha256: locks,
    builtAt: new Date().toISOString(), providerExecutables: 'operator-provided',
  };
  await writeFile(path.join(electron, 'generated/BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
  await node(['scripts/verify-electron-package.mjs', '--synced']);
  if (options.command === 'sync') return;
  const { output, previous } = await prepareElectronOutputDirectory(electron, options.profile);
  if (previous) console.log(`Preserved previous Electron ${options.profile} output: ${previous}`);
  await npm(['run', options.command === 'verify' || options.directory ? 'pack:dir' : 'pack'], electron);
  await node(['scripts/verify-electron-package.mjs', '--packaged']);
  const validation = {
    synchronizedAssets: true, packageContents: true, nativeRuntime: options.profile === 'full',
    runtimeSmoke: false, liveProviders: false,
    limitations: ['Validated only on the recorded host; other platforms require independent validation.', 'Unsigned preview; installation, signing, and live providers are not validated by this command.'],
  };
  // Preserve truthful provenance even when the runtime gate fails after a
  // successful package build (for example, a host without a secure keyring).
  await writeElectronOutputProvenance(output, { ...info, validation });
  if (options.command === 'verify') {
    try {
      await node(['scripts/run-electron-smoke.mjs', '--packaged', '--profile', options.profile]);
      validation.runtimeSmoke = true;
    } catch (error) {
      validation.runtimeSmokeFailure = error.message;
      throw error;
    } finally { await writeElectronOutputProvenance(output, { ...info, validation }); }
  }
  console.log(`Electron ${options.profile} output: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runElectronDistribution(parseElectronDistributionArguments(process.argv.slice(2)));
