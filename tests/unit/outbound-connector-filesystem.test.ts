import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertConnectorFiles, ensureConnectorDirectories } from '../../src/server/sidecar/outbound-connector-filesystem.js';
import { windowsSidecarPlatform } from '../../src/server/sidecar/sidecar-windows-platform.js';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('batched connector filesystem verification', () => {
  it('batches Windows namespace creation without dropping an ordered directory', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const batch = vi.spyOn(windowsSidecarPlatform, 'privacyBatch').mockResolvedValue();
    await ensureConnectorDirectories(['C:\\private', 'C:\\private\\incoming']);
    expect(batch).toHaveBeenCalledExactlyOnceWith([{ filename: 'C:\\private', operation: 'ensure-directory' }, { filename: 'C:\\private\\incoming', operation: 'ensure-directory' }]);
  });
  it('rechecks current file metadata and fails links before native batch admission', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sedes-batch-files-')); directories.push(directory);
    const first = path.join(directory, 'first'); const second = path.join(directory, 'second');
    await writeFile(first, 'one'); await writeFile(second, 'two');
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const batch = vi.spyOn(windowsSidecarPlatform, 'privacyBatch').mockResolvedValue();
    const entries = [first, second].map(filename => ({ filename, maximumBytes: 3, executable: true }));
    await assertConnectorFiles(entries);
    expect(batch).toHaveBeenCalledTimes(1);
    await writeFile(second, 'oversized');
    await expect(assertConnectorFiles(entries)).rejects.toThrow('outbound_state_file_invalid');
    expect(batch).toHaveBeenCalledTimes(1);
    await rm(second); await symlink(first, second);
    await expect(assertConnectorFiles(entries)).rejects.toThrow('outbound_state_file_invalid');
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
