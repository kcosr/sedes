#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertServerRuntimeBoundary } from './check-server-runtime.mjs';
import { assertBuildTarget, buildNativeAddons, prunePlatformPackages } from './server-package-native.mjs';
import { writePackageIntegrity, verifyPackageIntegrity } from './server-package-integrity.mjs';
import { writeServerWrappers } from './install-server-lib.mjs';
import { verifyRuntime } from './verify-server-package.mjs';
import { resolveServerToolchain } from './server-package-toolchain.mjs';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--target','--output','--nodedir'].includes(key) || !process.argv[index + 1] || options[key]) throw new Error('Usage: npm run package:server -- --target linux-x86_64|linux-arm64|macos-x86_64|macos-arm64 --output /absolute/directory [--nodedir /node/headers/root]');
  options[key] = process.argv[index + 1];
}
const target = assertBuildTarget(options['--target']);
if (!options['--output'] || !path.isAbsolute(options['--output'])) throw new Error('--output must be an absolute directory');
const output = path.resolve(options['--output']);
if (output === repositoryRoot || output.startsWith(repositoryRoot + path.sep)) throw new Error('Packages must be written outside the source checkout');
const env = {...process.env, PATH:`${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`};
delete env.NODE_ENV;
const run = async (command, args, cwd = repositoryRoot, extraEnv = {}) => {
  try { return await execute(command, args, {cwd, env:{...env, ...extraEnv}, maxBuffer:64*1024*1024}); }
  catch (error) { process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error; }
};
const git = async (...args) => (await run('git', args)).stdout.trim();
if (await git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Package from a clean committed checkout; preserve and commit source changes first.');
const commit = await git('rev-parse', 'HEAD');
const commitTimestamp = await git('show', '-s', '--format=%cI', 'HEAD');
const branch = await git('branch', '--show-current');
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const stamp = new Date(commitTimestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const name = `sedes_${stamp}_${commit.slice(0,12)}_${target.label}`;
await mkdir(output, {recursive:true});
for (const item of [name, `${name}.tar.gz`, `${name}.tar.gz.sha256`]) {
  if (await lstat(path.join(output, item)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) throw new Error(`Refusing to replace existing ${item}`);
}
const temporary = await mkdtemp(path.join(output, '.sedes-package-'));
const stage = path.join(temporary, name);
const buildStartedAt = new Date().toISOString();
let extractionDirectory;
const published = [];
let complete = false;
try {
  const toolchain = await resolveServerToolchain(repositoryRoot, { environment: env });
  Object.assign(env, toolchain.environment);
  console.log('Building browser, server, workers, and sidecars from committed source…');
  await run('npm', ['run', 'build']);
  await assertServerRuntimeBoundary({repositoryRoot, distRoot:path.join(repositoryRoot, 'dist')});
  await mkdir(stage);
  for (const filename of ['package.json','package-lock.json']) await cp(path.join(repositoryRoot, 'packages/server-runtime', filename), path.join(stage, filename));
  await cp(path.join(repositoryRoot, 'dist'), path.join(stage, 'dist'), {recursive:true, filter: filename => !filename.endsWith('.map') && !filename.endsWith('.test.js')});
  for (const filename of ['LICENSE','THIRD-PARTY-NOTICES.md','config/server.example.json']) {
    await mkdir(path.dirname(path.join(stage, filename)), {recursive:true});
    await cp(path.join(repositoryRoot, filename), path.join(stage, filename));
  }
  await cp(path.join(repositoryRoot, 'docs/operator/server-distribution.md'), path.join(stage, 'README.md'));
  await mkdir(path.join(stage, 'scripts'));
  for (const filename of ['install-server.mjs','install-server-lib.mjs','install-server-runtime.mjs','server-package-integrity.mjs','server-package-payload.mjs','verify-server-package.mjs']) await cp(path.join(repositoryRoot, 'scripts', filename), path.join(stage, 'scripts', filename));
  console.log('Installing the locked server graph without lifecycle hooks…');
  await run('npm', ['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'], stage);
  const removedPackages = await prunePlatformPackages(path.join(stage, 'node_modules'), target);
  console.log('Compiling SQLite and PTY addons for this Node runtime…');
  const nativeBuilds = await buildNativeAddons(repositoryRoot, stage, {nodedir:options['--nodedir'],environment:env});
  // Rebuild the sidecar with only the freshly compiled target addon. The normal
  // development/Electron build remains free to collect its portable payloads.
  await rm(path.join(stage, 'dist/sidecar'), {recursive:true});
  await run(process.execPath, ['scripts/build-sidecar.mjs','--output-directory',path.join(stage, 'dist/sidecar')], repositoryRoot, {SEDES_PACKAGE_NODE_PTY_ROOT:path.join(stage,'node_modules/node-pty')});
  for (const name of ['better-sqlite3','node-pty']) {
    for (const relative of ['prebuilds','src','deps','binding.gyp','third_party']) await rm(path.join(stage,'node_modules',name,relative), {recursive:true,force:true});
  }
  await writeServerWrappers(stage);
  console.log('Checking isolated runtime, browser assets, migrations, providers, and PTY…');
  const checks = await verifyRuntime(stage);
  const nativeLibraries = [];
  async function nativeFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await nativeFiles(path.join(directory,entry.name),relative));
      else if (entry.isFile() && (entry.name.endsWith('.node') || entry.name === 'spawn-helper')) files.push(relative);
    }
    return files;
  }
  for (const relative of await nativeFiles(stage)) {
    const command = target.platform === 'linux' ? 'ldd' : 'otool';
    const args = target.platform === 'linux' ? [path.join(stage,relative)] : ['-L',path.join(stage,relative)];
    nativeLibraries.push({file:relative, command, output:(await run(command,args)).stdout.replaceAll(stage, '<release>')});
  }
  const lock = JSON.parse(await readFile(path.join(stage,'package-lock.json'),'utf8'));
  const toolVersion = async (command, args) => (await run(command,args)).stdout.trim();
  const info = {
    format:1, version:manifest.version,
    source:{commit,branch,commitTimestamp,dirty:false}, target,
    node:{minimum:'24.18.0',version:process.version,abi:process.versions.modules},
    host:{platform:os.platform(),architecture:os.arch(),release:os.release(),distribution:target.platform === 'linux' ? await readFile('/etc/os-release','utf8').catch(() => null) : await toolVersion('sw_vers',[]),glibc:process.report.getReport().header.glibcVersionRuntime ?? null},
    build:{startedAt:buildStartedAt,completedAt:new Date().toISOString(),command:process.argv,...toolchain.provenance,nodeGyp:JSON.parse(await readFile(path.join(repositoryRoot,'node_modules/node-gyp/package.json'),'utf8')).version,nativeBuilds},
    lockedDependencies:Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key).map(([key,value]) => [key,{version:value.version,integrity:value.integrity}])),
    removedPackages,nativeLibraries,
    validation:{checks,liveProviders:false,limitations:['Validated only on the recorded build host; other distributions and targets require independent validation.','Worker/sidecar probes validate module loading and argument guards; they do not exercise sandbox or remote/provider sessions.']},
    packagedAt:new Date().toISOString(),
  };
  if (await git('rev-parse','HEAD') !== commit || await git('status','--porcelain','--untracked-files=normal')) throw new Error('Source changed during packaging; retry from a clean committed checkout.');
  await writeFile(path.join(stage,'BUILD-INFO.json'), JSON.stringify(info,null,2)+'\n');
  await writePackageIntegrity(stage);
  await verifyPackageIntegrity(stage);
  console.log('Archiving and checking a fresh extraction…');
  const archive = path.join(temporary,`${name}.tar.gz`);
  await run('tar',['-czf',archive,'-C',temporary,name]);
  // Extract outside the workspace so its node_modules cannot mask an omission.
  const extracted = await mkdtemp(path.join(os.tmpdir(),'sedes-extract-'));
  extractionDirectory = extracted;
  await run('tar',['-xpzf',archive,'-C',extracted]);
  const extractedRoot = path.join(extracted,name);
  await verifyPackageIntegrity(extractedRoot);
  await verifyRuntime(extractedRoot);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(path.join(temporary,`${name}.tar.gz.sha256`),`${sha256}  ${name}.tar.gz\n`);
  for (const item of [name,`${name}.tar.gz`,`${name}.tar.gz.sha256`]) {
    await rename(path.join(temporary,item),path.join(output,item));
    published.push(path.join(output,item));
  }
  complete = true;
  console.log(JSON.stringify({archive:path.join(output,`${name}.tar.gz`),directory:path.join(output,name),sha256,extractionVerified:true},null,2));
} finally {
  const cleanup = [...(!complete ? published.reverse() : []), ...(extractionDirectory ? [extractionDirectory] : []), temporary];
  const results = await Promise.allSettled(cleanup.map(filename => rm(filename,{recursive:true,force:true})));
  for (let index = 0; index < results.length; index++) {
    if (results[index].status === 'rejected') console.error(`Cleanup failed for ${cleanup[index]}: ${results[index].reason}`);
  }
}
