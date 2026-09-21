import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyRuntime } from '../../scripts/verify-server-package.mjs';

const temporary = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('package verification executable isolation', () => {
  it.skipIf(process.platform === 'win32').each([false, true])('uses the selected executable with explicit Electron mode %s and isolated state', async electronRunAsNode => {
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
    const error = await verifyRuntime(root, { nodeExecutable: executable, electronRunAsNode }).catch(error => error);
    expect(error.code).toBe(42);
    const observed = JSON.parse(error.stderr.trim());
    expect(observed).toMatchObject({ selected: true, electron: electronRunAsNode ? '1' : null, secret: null, nodeOptions: null });
    expect(observed.args[0]).toBe('--input-type=module');
    expect(observed.args.at(-1)).toBe(root);
    expect(observed.home).not.toBe(process.env.HOME);
    expect(await access(observed.home).then(() => true, () => false)).toBe(false);
  });
});
