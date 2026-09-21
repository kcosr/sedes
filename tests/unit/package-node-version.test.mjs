import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertPackageNodeVersion } from '../../scripts/package-node-version.mjs';

describe('package CLI Node requirement', () => {
  it.each(['18.20.8', '20.19.0', '22.17.0', '24.0.0', '24.1.0', '24.17.9', 'invalid'])('refuses %s before checking the entry marker', version => {
    expect(() => assertPackageNodeVersion(version)).toThrow('Node.js 24.18.0 or newer');
  });
  it.each(['24.18.0', '24.19.1', '25.0.0'])('accepts %s for entry detection (server ABI checked separately)', version => {
    expect(() => assertPackageNodeVersion(version)).not.toThrow();
  });
  it.each(['verify-server-package.mjs', 'check-server-runtime.mjs', 'electron-distribution.mjs', 'prepare-electron-local-server.mjs'])('%s rejects an unsupported reported Node version even as a library import', async filename => {
    const entry = fileURLToPath(new URL(`../../scripts/${filename}`, import.meta.url));
    // Exercise the module-load gate without downloading an obsolete runtime.
    const command = promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      'import {pathToFileURL} from "node:url"; Object.defineProperty(process.versions,"node",{value:"20.19.0"}); await import(pathToFileURL(process.argv[1]));', entry]);
    await expect(command).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Node.js 24.18.0 or newer') });
  });
});
