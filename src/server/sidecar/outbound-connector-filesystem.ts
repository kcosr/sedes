import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { windowsSidecarPlatform } from './sidecar-windows-platform.js';

export async function ensureConnectorDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    await windowsSidecarPlatform.privacy(directory, 'ensure-directory');
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertConnectorDirectory(directory);
}

/** One native request for the small, ordered installation namespace. */
export async function ensureConnectorDirectories(directories: readonly string[]): Promise<void> {
  if (process.platform === 'win32') {
    await windowsSidecarPlatform.privacyBatch(directories.map(filename => ({ filename, operation: 'ensure-directory' })));
    return;
  }
  for (const directory of directories) await ensureConnectorDirectory(directory);
}

export async function assertConnectorDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('outbound_state_directory_invalid');
  if (process.platform === 'win32') await windowsSidecarPlatform.privacy(directory, 'assert-directory');
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('outbound_state_directory_invalid');
}

async function connectorFileMetadata(filename: string, maximumBytes: number) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes || await realpath(filename) !== filename) throw new Error('outbound_state_file_invalid');
  return stat;
}

export async function assertConnectorFile(filename: string, maximumBytes: number, executable: boolean | 'readonly' = false): Promise<void> {
  const stat = await connectorFileMetadata(filename, maximumBytes);
  if (process.platform === 'win32') await windowsSidecarPlatform.privacy(filename, executable ? 'assert-executable' : 'assert-file');
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (executable === 'readonly' ? 0o400 : executable ? 0o500 : 0o600)) throw new Error('outbound_state_file_invalid');
}

/** Reinspect every path and ACL; no directory timestamp or previous result is reused. */
export async function assertConnectorFiles(files: readonly { filename: string; maximumBytes: number; executable?: boolean | 'readonly' }[]): Promise<void> {
  if (process.platform === 'win32') {
    for (const file of files) await connectorFileMetadata(file.filename, file.maximumBytes);
    await windowsSidecarPlatform.privacyBatch(files.map(file => ({ filename: file.filename, operation: file.executable ? 'assert-executable' : 'assert-file' })));
    return;
  }
  for (const file of files) await assertConnectorFile(file.filename, file.maximumBytes, file.executable);
}

export async function sealConnectorFile(filename: string, executable: boolean | 'readonly' = false): Promise<void> {
  if (process.platform === 'win32') await windowsSidecarPlatform.privacy(filename, executable ? 'secure-executable' : 'secure-file');
  else await chmod(filename, executable === 'readonly' ? 0o400 : executable ? 0o500 : 0o600);
}

export async function syncConnectorDirectory(directory: string): Promise<void> {
  // Windows does not expose POSIX directory fsync through Node's file handles.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
