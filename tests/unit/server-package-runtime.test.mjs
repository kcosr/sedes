import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntimeDependencyProbe, readRuntimeEntrypoints, verifyRuntime } from '../../scripts/verify-server-package.mjs';
import { discoverRuntimeEntrypoints, writeRuntimeEntrypoints } from '../../scripts/check-server-runtime.mjs';
import { verifyPackageIntegrity, writePackageIntegrity } from '../../scripts/server-package-integrity.mjs';

const temporary = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('package verification executable isolation', () => {
  it.skipIf(process.platform === 'win32')('executes the CLI through a symlink and refuses an invalid release', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-verifier-cli-'));
    temporary.push(root);
    const alias = path.join(root, 'checkout');
    await symlink(fileURLToPath(new URL('../../', import.meta.url)), alias);
    const execute = promisify(execFile);
    await expect(execute(process.execPath, [path.join(alias, 'scripts/verify-server-package.mjs'), '--package', root]))
      .rejects.toMatchObject({ code: 1 });
  });
  it.each(['verify-server-package.mjs', 'check-server-runtime.mjs', 'electron-distribution.mjs', 'prepare-electron-local-server.mjs'])('does not enter %s when imported even if argv names it', async filename => {
    const verifier = fileURLToPath(new URL(`../../scripts/${filename}`, import.meta.url));
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      'import {pathToFileURL} from "node:url"; await import(pathToFileURL(process.argv[1])); console.log("imported");', verifier]);
    expect(result.stdout.trim()).toBe('imported');
  });
  it.skipIf(process.platform === 'win32').each([[false, false], [true, false], [false, true], [true, true]])('uses the selected executable with Electron mode %s, symlink root %s, and isolated state', async (electronRunAsNode, alias) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-verifier-runtime-'));
    temporary.push(root);
    for (const directory of ['server', 'cli', 'shared', 'internal']) await mkdir(path.join(root, 'dist', directory), { recursive: true });
    await writeRuntimeEntrypoints(root);
    const executable = path.join(root, 'selected-runtime');
    await writeFile(executable, `#!${process.execPath}
console.error(JSON.stringify({ selected: true, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, home: process.env.HOME, secret: process.env.SEDES_TEST_PROVIDER_SECRET ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, args: process.argv.slice(2) }));
process.exit(42);
`);
    await chmod(executable, 0o755);
    vi.stubEnv('ELECTRON_RUN_AS_NODE', 'inherited-untrusted-mode');
    vi.stubEnv('SEDES_TEST_PROVIDER_SECRET', 'must-not-leak');
    vi.stubEnv('NODE_OPTIONS', '--invalid-option-must-not-leak');
    const selectedRoot = alias ? `${root}-current` : root;
    if (alias) { await symlink(root, selectedRoot); temporary.push(selectedRoot); }
    const error = await verifyRuntime(selectedRoot, { nodeExecutable: executable, electronRunAsNode }).catch(error => error);
    expect(error.code).toBe(42);
    const observed = JSON.parse(error.stderr.trim());
    expect(observed).toMatchObject({ selected: true, electron: electronRunAsNode ? '1' : null, secret: null, nodeOptions: null });
    expect(observed.args[0]).toBe('--input-type=module');
    expect(observed.args.at(-1)).toBe(await realpath(root));
    expect(observed.home).not.toBe(process.env.HOME);
    expect(await access(observed.home).then(() => true, () => false)).toBe(false);
    expect(observed.args[2]).toContain("['pi', 'codex', 'claude', 'grok', 'opencode']");
  });
});

describe('packaged runtime export entrypoints', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-entrypoints-')); temporary.push(root);
    for (const directory of ['server', 'cli', 'shared', 'internal']) await mkdir(path.join(root, 'dist', directory), { recursive: true });
    const dependency = path.join(root, 'node_modules', 'subpath-only'); await mkdir(dependency, { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'subpath-only': '1.0.0' } }));
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: {
      './feature': { import: './feature.mjs', require: './feature.cjs' }, './package.json': './package.json',
    } }));
    await writeFile(path.join(dependency, 'feature.mjs'), 'globalThis.sedesProbeImported = true;');
    await writeFile(path.join(dependency, 'feature.cjs'), 'globalThis.sedesProbeRequired = true;');
    await writeFile(path.join(root, 'dist/server/example.js'), `import 'subpath-only/feature';
      require('subpath-only/feature'); require.resolve('subpath-only/package.json');`);
    const entries = await discoverRuntimeEntrypoints(path.join(root, 'dist'));
    await writeRuntimeEntrypoints(root);
    const execute = (selected = entries, suffix = '') => promisify(execFile)(process.execPath,
      ['--input-type=module', '--eval', createRuntimeDependencyProbe(selected) + suffix, root], { cwd: root });
    return { root, dependency, entries, execute };
  }

  it('loads actual import and require subpaths without requiring a nonexistent package root export', async () => {
    const f = await fixture();
    await expect(f.execute(await readRuntimeEntrypoints(f.root), `
      assert.equal(globalThis.sedesProbeImported, true);
      assert.equal(globalThis.sedesProbeRequired, true);
    `)).resolves.toMatchObject({ stderr: '' });
    await expect(f.execute([{ package: 'subpath-only', specifier: 'subpath-only', kind: 'import' }]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('ERR_PACKAGE_PATH_NOT_EXPORTED') });
  });

  it('keeps complete declared-dependency coverage and rejects unexported runtime paths', async () => {
    const f = await fixture();
    await expect(f.execute([])).rejects.toMatchObject({ stderr: expect.stringContaining('Packaged runtime imports do not match declared dependencies') });
    await expect(f.execute([{ package: 'subpath-only', specifier: 'subpath-only/missing', kind: 'import' }]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('ERR_PACKAGE_PATH_NOT_EXPORTED') });
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ type: 'module', dependencies: {} }));
    await expect(f.execute()).rejects.toMatchObject({ stderr: expect.stringContaining('Packaged runtime imports do not match declared dependencies') });
  });

  it.skipIf(process.platform === 'win32')('rejects a real subpath that resolves outside packaged node_modules', async () => {
    const f = await fixture(); const outside = path.join(f.root, 'outside.mjs');
    await writeFile(outside, 'throw new Error("outside package must not execute");');
    await rm(path.join(f.dependency, 'feature.mjs')); await symlink(outside, path.join(f.dependency, 'feature.mjs'));
    await expect(f.execute()).rejects.toMatchObject({ stderr: expect.stringContaining('Dependency resolves outside package: subpath-only/feature') });
  });

  it.skipIf(process.platform === 'win32')('rejects a subpath redirected to a different package inside node_modules', async () => {
    const f = await fixture(); const other = path.join(f.root, 'node_modules', 'another-package'); await mkdir(other);
    await writeFile(path.join(other, 'feature.mjs'), 'throw new Error("another package must not execute");');
    await rm(path.join(f.dependency, 'feature.mjs')); await symlink(path.join(other, 'feature.mjs'), path.join(f.dependency, 'feature.mjs'));
    await expect(f.execute()).rejects.toMatchObject({ stderr: expect.stringContaining('Dependency resolves outside package: subpath-only/feature') });
  });

  it('requires a closed, bounded manifest with exact package ownership and import modes', async () => {
    const f = await fixture(); const entry = { package: 'subpath-only', specifier: 'subpath-only/feature', kind: 'import' };
    for (const invalid of [
      { version: 2, entrypoints: [entry] }, { version: 1, entrypoints: [entry], extra: true },
      { version: 1, entrypoints: [{ ...entry, extra: true }] },
      { version: 1, entrypoints: [{ ...entry, package: 'different-package' }] },
      { version: 1, entrypoints: [{ ...entry, specifier: 'subpath-only/../elsewhere' }] },
      { version: 1, entrypoints: [{ ...entry, specifier: 'file:///outside.js' }] },
      { version: 1, entrypoints: [{ ...entry, kind: 'eval' }] },
      { version: 1, entrypoints: [entry, entry] },
      { version: 1, entrypoints: Array(10_001).fill(entry) },
    ]) {
      await writeFile(path.join(f.root, 'runtime-entrypoints.json'), JSON.stringify(invalid));
      await expect(readRuntimeEntrypoints(f.root)).rejects.toThrow();
    }
    await writeFile(path.join(f.root, 'runtime-entrypoints.json'), ' '.repeat(1_048_577));
    await expect(readRuntimeEntrypoints(f.root)).rejects.toThrow('exceeds its byte limit');
    await rm(path.join(f.root, 'runtime-entrypoints.json'));
    await expect(readRuntimeEntrypoints(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('includes the generated entrypoints in normal package integrity coverage', async () => {
    const f = await fixture(); await writePackageIntegrity(f.root);
    const inventory = JSON.parse(await readFile(path.join(f.root, 'FILES.json'), 'utf8'));
    expect(inventory['runtime-entrypoints.json']).toMatchObject({ type: 'file', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    await writeFile(path.join(f.root, 'runtime-entrypoints.json'), '{"version":1,"entrypoints":[]}\n');
    await expect(verifyPackageIntegrity(f.root)).rejects.toThrow('Package integrity mismatch: runtime-entrypoints.json');
  });

  it('keeps the shipped standalone verifier importable without parser or build dependencies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-standalone-verifier-')); temporary.push(root);
    for (const name of ['verify-server-package.mjs', 'server-package-integrity.mjs', 'server-package-payload.mjs', 'package-node-version.mjs']) {
      await cp(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)), path.join(root, name));
    }
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      'await import("./verify-server-package.mjs"); console.log("standalone imported");'], { cwd: root, env: { ...process.env, NODE_PATH: '' } });
    expect(result.stdout.trim()).toBe('standalone imported');
  });
});
