import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildTarget, buildNativeAddons, prunePlatformPackages } from '../../scripts/server-package-native.mjs';
import { verifyRuntime } from '../../scripts/verify-server-package.mjs';

const temporary = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-native-test-'));
  temporary.push(root);
  return root;
}
async function put(root, relative, content = 'fixture') {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function pkg(modules, name, fields = {}) {
  const directory = path.join(modules, name);
  await put(directory, 'package.json', JSON.stringify({ name, version: '1.0.0', ...fields }));
  return directory;
}
const exists = file => access(file).then(() => true, () => false);

describe('server package native targets', () => {
  it('requires the selected host, minimum Node, and Linux glibc', () => {
    const host = { platform: 'linux', arch: 'x64', versions: { node: '24.18.0' }, report: { getReport: () => ({ header: { glibcVersionRuntime: '2.28' } }) } };
    expect(assertBuildTarget('linux-x86_64', host).arch).toBe('x64');
    expect(() => assertBuildTarget('linux-arm64', host)).toThrow('cross-compilation');
    expect(() => assertBuildTarget('linux-x86_64', { ...host, versions: { node: '24.17.0' } })).toThrow('24.18.0');
    expect(() => assertBuildTarget('linux-x86_64', { ...host, report: { getReport: () => ({ header: {} }) } })).toThrow('glibc');
  });

  it.each([{ platform: 'linux', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }])('keeps only the chosen nested esbuild binary and Pi embedded native payload: $platform/$arch', async target => {
    const root = await fixture();
    const modules = path.join(root, 'node_modules');
    const pi = await pkg(modules, '@earendil-works/pi-coding-agent');
    const nested = path.join(pi, 'node_modules');
    const tui = await pkg(nested, '@earendil-works/pi-tui', { version: '0.86.0' });
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        const suffix = platform === 'linux' ? '-x11' : '';
        await put(tui, `native/${platform}/prebuilds/${platform}-${arch}/${platform}-platform${suffix}.node`);
        await pkg(nested, `@esbuild/${platform}-${arch}`, { os: [platform], cpu: [arch] });
      }
    }
    await put(tui, 'native/napi.h');
    const sdk = await pkg(nested, '@anthropic-ai/claude-agent-sdk');
    await pkg(path.join(sdk, 'node_modules'), '@anthropic-ai/claude-agent-sdk-linux-x64');
    const removed = await prunePlatformPackages(modules, target);
    expect((await readdir(path.join(tui, 'native'))).sort()).toEqual([target.platform, 'napi.h'].sort());
    expect(await readdir(path.join(tui, 'native', target.platform, 'prebuilds'))).toEqual([`${target.platform}-${target.arch}`]);
    expect(await readdir(path.join(nested, '@esbuild'))).toEqual([`${target.platform}-${target.arch}`]);
    expect(await exists(path.join(sdk, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64'))).toBe(false);
    expect(removed.some(item => item.name === '@anthropic-ai/claude-agent-sdk-linux-x64')).toBe(true);
  });

  it.each(['@openai/codex', '@openai/codex-linux-x64', '@anthropic-ai/claude-code', 'electron', '@capacitor/android', '@capawesome/capacitor-electron'])('rejects forbidden nested runtime dependency %s', async name => {
    const root = await fixture();
    const parent = await pkg(path.join(root, 'node_modules'), 'parent');
    await pkg(path.join(parent, 'node_modules'), name);
    await expect(prunePlatformPackages(path.join(root, 'node_modules'), { platform: 'linux', arch: 'x64' })).rejects.toThrow(`Forbidden runtime dependency: ${name}`);
  });

  it('does not silently accept a missing nested manifest', async () => {
    const root = await fixture();
    const parent = await pkg(path.join(root, 'node_modules'), 'parent');
    await put(parent, 'node_modules/incomplete/index.js');
    await expect(prunePlatformPackages(path.join(root, 'node_modules'), { platform: 'linux', arch: 'x64' })).rejects.toThrow('ENOENT');
  });

  it('fails closed when the pinned Pi native layout changes', async () => {
    const root = await fixture();
    await pkg(path.join(root, 'node_modules'), '@earendil-works/pi-tui', { version: '0.87.0' });
    await expect(prunePlatformPackages(path.join(root, 'node_modules'), { platform: 'linux', arch: 'x64' })).rejects.toThrow('Unreviewed Pi native layout');
  });

  async function nativeFixture() {
    const root = await fixture();
    for (const [name, version] of [['better-sqlite3', '13.0.2'], ['node-pty', '1.1.0']]) {
      const directory = await pkg(path.join(root, 'node_modules'), name, { version });
      await put(directory, 'prebuilds/incompatible.node', 'stale');
      await put(directory, 'build/Release/stale.node', 'stale');
      await put(directory, 'third_party/conpty/win32-x64/conpty.dll', 'unused Windows DLL');
    }
    return root;
  }

  it('forces clean source builds for this Node ABI and retains only runtime outputs', async () => {
    const root = await nativeFixture();
    const calls = [];
    const result = await buildNativeAddons(root, root, {
      nodedir: root,
      environment: { PATH: '/usr/bin', NODE_ENV: 'production', npm_config_runtime: 'electron', NPM_CONFIG_TARGET: 'other', CC: 'cc' },
      run: async (executable, args, options) => {
        calls.push({ executable, args, options });
        expect(await exists(path.join(options.cwd, 'prebuilds'))).toBe(false);
        expect(await exists(path.join(options.cwd, 'build'))).toBe(false);
        const outputs = path.basename(options.cwd) === 'better-sqlite3' ? ['better_sqlite3.node'] : ['pty.node', ...(process.platform === 'darwin' ? ['spawn-helper'] : [])];
        for (const output of outputs) await put(options.cwd, `build/Release/${output}`, `fresh:${output}`);
        await put(options.cwd, 'build/Release/sqlite3.a', 'compiler artifact');
        await put(options.cwd, 'build/Release/obj.target/intermediate.o', 'compiler artifact');
      },
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.executable).toBe(process.execPath);
      expect(call.args).toEqual(expect.arrayContaining(['rebuild', '--release', '--force_build=1', `--target=${process.versions.node}`, `--arch=${process.arch}`, `--nodedir=${root}`]));
      expect(call.options.env.NODE_ENV).toBeUndefined();
      expect(call.options.env.npm_config_runtime).toBeUndefined();
      expect(call.options.env.NPM_CONFIG_TARGET).toBeUndefined();
      expect(call.options.env.CC).toBe('cc');
    }
    for (const build of result) {
      const directory = path.join(root, 'node_modules', build.name);
      expect((await readdir(path.join(directory, 'build/Release'))).sort()).toEqual([...build.outputs].sort());
      expect(await exists(path.join(directory, '.sedes-native'))).toBe(false);
      expect(await exists(path.join(directory, 'third_party'))).toBe(false);
      for (const output of build.outputs) expect((await stat(path.join(directory, 'build/Release', output))).mode & 0o777).toBe(0o755);
    }
    expect(await exists(path.join(root, 'node_modules/better-sqlite3/prebuilds'))).toBe(false);
    const native = path.join(root, 'node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`);
    expect(await readFile(path.join(native, 'pty.node'), 'utf8')).toBe('fresh:pty.node');
    expect(JSON.parse(await readFile(path.join(native, 'sidecar-native.json'), 'utf8')).nodeModuleVersion).toBe(process.versions.modules);
  });

  it('propagates compiler failure and never falls back to a stale prebuild', async () => {
    const root = await nativeFixture();
    await expect(buildNativeAddons(root, root, { run: async () => { throw new Error('compiler failed'); } })).rejects.toThrow('compiler failed');
    expect(await exists(path.join(root, 'node_modules/better-sqlite3/prebuilds'))).toBe(false);
    expect(await exists(path.join(root, 'node_modules/better-sqlite3/build'))).toBe(false);
  });

  it('rejects unreviewed native versions before running the compiler', async () => {
    const root = await nativeFixture();
    await pkg(path.join(root, 'node_modules'), 'better-sqlite3', { version: '14.0.0' });
    let called = false;
    await expect(buildNativeAddons(root, root, { run: async () => { called = true; } })).rejects.toThrow('Unreviewed native dependency');
    expect(called).toBe(false);
  });

  it('rejects dependencies resolved from an ancestor before importing package code', async () => {
    const root = await fixture();
    await pkg(path.join(root, 'node_modules'), 'ancestor-only', { main: 'index.js' });
    await put(root, 'node_modules/ancestor-only/index.js', 'module.exports = {};');
    const release = path.join(root, 'releases/example');
    await put(release, 'package.json', JSON.stringify({ dependencies: { 'ancestor-only': '1.0.0' } }));
    await expect(verifyRuntime(release)).rejects.toThrow('Dependency resolves outside package: ancestor-only');
  });
});
