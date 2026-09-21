import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseElectronDistributionArguments, writeElectronDistribution, writeElectronOutputProvenance } from '../../scripts/electron-distribution.mjs';
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
    for (const args of [['package','--profile','unknown'], ['verify','--dir'], ['sync','--profile','client','--profile','full'], ['package','--dir','--dir']]) expect(() => parseElectronDistributionArguments(args)).toThrow();
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
});

describe('Electron source native rebuilds', () => {
  it.each(['linux', 'darwin', 'win32'])('forces source builds and retains required %s runtime outputs', async platform => {
    const root = await fixture();
    for (const [name, version] of [['better-sqlite3', '13.0.2'], ['node-pty', '1.1.0']]) {
      await put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }));
      await put(root, `node_modules/${name}/prebuilds/stale.node`);
      await put(root, `node_modules/${name}/build/Release/stale.node`);
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
