import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanElectronPreviousOutputs, parseElectronDistributionArguments, prepareElectronOutputDirectory, writeElectronDistribution, writeElectronOutputProvenance } from '../../scripts/electron-distribution.mjs';
import { electronNativeOutputs, rebuildElectronNativeAddons } from '../../scripts/prepare-electron-local-server.mjs';

const temporary = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() { const directory = await mkdtemp(path.join(os.tmpdir(), 'sedes-electron-distribution-')); temporary.push(directory); return directory; }
async function put(root, name, contents = 'fixture') { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
const exists = filename => access(filename).then(() => true, () => false);

describe('Electron distribution profiles', () => {
  it('defaults existing workflows to full and rejects ambiguous profiles/options', () => {
    expect(parseElectronDistributionArguments(['sync'])).toEqual({ command: 'sync', profile: 'full', directory: false });
    expect(parseElectronDistributionArguments(['package', '--profile', 'client', '--dir'])).toEqual({ command: 'package', profile: 'client', directory: true });
    expect(parseElectronDistributionArguments(['clean', '--profile', 'client'])).toEqual({ command: 'clean', profile: 'client', directory: false });
    for (const args of [['package','--profile','unknown'], ['verify','--dir'], ['sync','--profile','client','--profile','full'], ['package','--dir','--dir'], ['clean'], ['clean', '--profile', 'full', '--dir']]) expect(() => parseElectronDistributionArguments(args)).toThrow();
  });
  it('clears stale full payload when switching profiles and writes only the native-owned profile', async () => {
    const root = await fixture();
    await put(root, 'generated/local-server/node_modules/old-native.node');
    await writeElectronDistribution(root, 'client');
    expect(await exists(path.join(root, 'generated/local-server'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, 'generated/distribution.json'), 'utf8'))).toEqual({ profile: 'client' });
    await writeElectronDistribution(root, 'full');
    expect(JSON.parse(await readFile(path.join(root, 'generated/distribution.json'), 'utf8'))).toEqual({ profile: 'full' });
  });
  it.each(['client', 'full'])('builder isolates outputs and server resources for %s', async profile => {
    const root = await fixture();
    await cp(new URL('../../electron/electron-builder.config.js', import.meta.url), path.join(root, 'builder.cjs'));
    await writeElectronDistribution(root, profile);
    const config = createRequire(import.meta.url)(path.join(root, 'builder.cjs'));
    expect(config.directories.output).toBe(`dist/${profile}`);
    expect(config.artifactName).toContain(`sedes-${profile}-`);
    expect(config.extraResources.length > 0).toBe(profile === 'full');
    if (profile === 'client') await expect(config.afterPack({})).resolves.toBeUndefined();
  });
  it('records unpacked file checksums, metadata, and symlinks', async () => {
    const root = await fixture();
    await put(root, 'linux-unpacked/sedes', 'executable');
    await symlink('sedes', path.join(root, 'linux-unpacked/alias'));
    await writeElectronOutputProvenance(root, { profile: 'client', sourceCommit: 'test' });
    const sums = await readFile(path.join(root, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain(`${createHash('sha256').update('executable').digest('hex')}  linux-unpacked/sedes`);
    const metadata = JSON.parse(await readFile(path.join(root, 'BUILD-INFO.json'), 'utf8'));
    expect(metadata.symlinks).toEqual({ 'linux-unpacked/alias': 'sedes' });
    expect(sums).toContain('  BUILD-INFO.json');
  });
  it('preserves old installers without relabeling them during a later directory-only build', async () => {
    const root = await fixture();
    await put(root, 'dist/full/sedes-old.AppImage', 'old installer');
    await put(root, 'dist/full/BUILD-INFO.json', JSON.stringify({ sourceCommit: 'old-commit' }));
    await put(root, 'dist/full/SHA256SUMS', 'old checksums');
    await put(root, 'dist/client/keep.txt', 'other profile');
    const { output, previous } = await prepareElectronOutputDirectory(root, 'full');
    expect(await readdir(output)).toEqual([]);
    expect(await readFile(path.join(previous, 'sedes-old.AppImage'), 'utf8')).toBe('old installer');
    expect(JSON.parse(await readFile(path.join(previous, 'BUILD-INFO.json'), 'utf8')).sourceCommit).toBe('old-commit');
    expect(await readFile(path.join(previous, 'SHA256SUMS'), 'utf8')).toBe('old checksums');
    expect(await readFile(path.join(root, 'dist/client/keep.txt'), 'utf8')).toBe('other profile');
    await put(output, 'linux-unpacked/sedes', 'new executable');
    await writeElectronOutputProvenance(output, { sourceCommit: 'new-commit', profile: 'full' });
    const checksums = await readFile(path.join(output, 'SHA256SUMS'), 'utf8');
    expect(checksums).toContain('linux-unpacked/sedes');
    expect(checksums).not.toContain('sedes-old.AppImage');
    expect(JSON.parse(await readFile(path.join(output, 'BUILD-INFO.json'), 'utf8')).sourceCommit).toBe('new-commit');
  });
  it('creates fresh profile output and refuses a non-directory output path', async () => {
    const root = await fixture();
    const first = await prepareElectronOutputDirectory(root, 'full');
    expect(first.previous).toBeUndefined();
    expect(await readdir(first.output)).toEqual([]);
    await put(root, 'dist/client', 'not a directory');
    await expect(prepareElectronOutputDirectory(root, 'client')).rejects.toThrow('output_not_directory');
    expect(await readFile(path.join(root, 'dist/client'), 'utf8')).toBe('not a directory');
  });
  it('cleans only explicitly selected prior output after repeated builds', async () => {
    const root = await fixture();
    for (let build = 0; build < 3; build++) {
      const { output } = await prepareElectronOutputDirectory(root, 'full');
      await put(output, 'installer.exe', `build-${build}`);
    }
    await put(root, 'dist/client/current.txt', 'current other profile');
    await put(root, 'dist/previous-client-AbCd12/installer.exe', 'previous other profile');
    await put(root, 'dist/previous-full-manual-backup/keep.txt', 'unmatched directory');
    await put(root, 'dist/previous-full-FILE12', 'regular file');
    await symlink(path.join(root, 'dist/client'), path.join(root, 'dist/previous-full-LINK12'), process.platform === 'win32' ? 'junction' : 'dir');
    const removed = await cleanElectronPreviousOutputs(root, 'full');
    expect(removed).toHaveLength(2);
    for (const previous of removed) expect(await exists(previous)).toBe(false);
    expect(await readFile(path.join(root, 'dist/full/installer.exe'), 'utf8')).toBe('build-2');
    expect(await readFile(path.join(root, 'dist/client/current.txt'), 'utf8')).toBe('current other profile');
    expect(await readFile(path.join(root, 'dist/previous-client-AbCd12/installer.exe'), 'utf8')).toBe('previous other profile');
    expect(await readFile(path.join(root, 'dist/previous-full-manual-backup/keep.txt'), 'utf8')).toBe('unmatched directory');
    expect(await readFile(path.join(root, 'dist/previous-full-FILE12'), 'utf8')).toBe('regular file');
    expect(await exists(path.join(root, 'dist/previous-full-LINK12'))).toBe(true);
    expect(await cleanElectronPreviousOutputs(root, 'full')).toEqual([]);
  });
});

describe('Electron source native rebuilds', () => {
  it.each(['linux', 'darwin', 'win32'])('forces source builds and retains required %s runtime outputs', async platform => {
    const root = await fixture();
    for (const [name, version] of [['better-sqlite3', '13.0.2'], ['node-pty', '1.1.0']]) {
      await put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }));
      await put(root, `node_modules/${name}/prebuilds/stale.node`);
      await put(root, `node_modules/${name}/build/Release/stale.node`);
      await put(root, `node_modules/${name}/third_party/conpty/conpty.dll`, 'unused Windows DLL');
    }
    const outputs = electronNativeOutputs(platform);
    await rebuildElectronNativeAddons(root, { electronVersion: '44.0.0', platform, arch: 'x64', rebuild: async options => {
      expect(options).toMatchObject({ electronVersion: '44.0.0', platform, arch: 'x64', force: true, buildFromSource: true, onlyModules: ['better-sqlite3', 'node-pty'] });
      for (const [name, files] of Object.entries(outputs)) {
        expect(await exists(path.join(root, 'node_modules', name, 'prebuilds'))).toBe(false);
        expect(await exists(path.join(root, 'node_modules', name, 'build'))).toBe(false);
        for (const file of files) await put(root, `node_modules/${name}/build/Release/${file}`, 'fresh');
        await put(root, `node_modules/${name}/build/Release/compiler.o`);
      }
    } });
    for (const [name, files] of Object.entries(outputs)) {
      const release = path.join(root, 'node_modules', name, 'build/Release');
      expect(await exists(path.join(root, 'node_modules', name, 'third_party'))).toBe(false);
      expect((await readdir(release)).sort()).toEqual([...files].sort());
      if (platform !== 'win32') for (const file of files) expect((await stat(path.join(release, file))).mode & 0o777).toBe(0o755);
    }
    if (platform === 'win32') expect(outputs['node-pty']).toEqual(expect.arrayContaining(['conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe']));
  });
  it('stops on compiler failure after removing incompatible prebuilds', async () => {
    const root = await fixture();
    for (const [name, version] of [['better-sqlite3','13.0.2'], ['node-pty','1.1.0']]) {
      await put(root, `node_modules/${name}/package.json`, JSON.stringify({ version }));
      await put(root, `node_modules/${name}/prebuilds/stale.node`);
    }
    await expect(rebuildElectronNativeAddons(root, { electronVersion: '44.0.0', rebuild: async () => { throw new Error('compiler failed'); } })).rejects.toThrow('compiler failed');
    expect(await exists(path.join(root, 'node_modules/better-sqlite3/prebuilds'))).toBe(false);
  });
});
