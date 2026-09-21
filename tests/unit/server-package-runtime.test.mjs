import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyRuntime } from '../../scripts/verify-server-package.mjs';

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
  });
});
