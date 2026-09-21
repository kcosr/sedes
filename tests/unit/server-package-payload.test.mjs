import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNativeFileTarget, inspectNativeHeader, verifyServerPayload } from '../../scripts/server-package-payload.mjs';

const temporary = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
function elf(arch = 'x64') {
  const bytes = Buffer.alloc(64); bytes.writeUInt32BE(0x7f454c46); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18); return bytes;
}
function pe(arch = 'x64') {
  const bytes = Buffer.alloc(134); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132); return bytes;
}
function mach(arch = 'x64') {
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4); return bytes;
}
async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-payload-')); temporary.push(root);
  for (const [name, bytes] of Object.entries(entries)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  return root;
}

describe('server package embedded payload validation', () => {
  it.each([['linux', elf], ['win32', pe], ['darwin', mach]])('identifies %s binary platform and CPU', (platform, make) => {
    for (const arch of ['x64', 'arm64']) {
      const bytes = make(arch);
      expect(inspectNativeHeader(bytes)).toEqual({ platform, architectures: [arch] });
      expect(() => assertNativeFileTarget('runtime.node', bytes, { platform, arch })).not.toThrow();
      expect(() => assertNativeFileTarget('runtime.node', bytes, { platform, arch: arch === 'x64' ? 'arm64' : 'x64' })).toThrow('Foreign native binary');
    }
  });
  it('recognizes a universal macOS binary on either included CPU', () => {
    const bytes = Buffer.alloc(48); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(0x01000007, 8); bytes.writeUInt32BE(0x0100000c, 28);
    expect(inspectNativeHeader(bytes)).toEqual({ platform: 'darwin', architectures: ['x64', 'arm64'] });
    expect(() => assertNativeFileTarget('helper', bytes, { platform: 'linux', arch: 'x64' })).toThrow('Foreign native binary');
  });
  it('rejects foreign extensions and renamed foreign executables', () => {
    for (const filename of ['third_party/conpty.dll', 'third_party/OpenConsole.exe', 'lib.dylib']) expect(() => assertNativeFileTarget(filename, Buffer.from('text'), { platform: 'linux', arch: 'x64' })).toThrow('Foreign native file');
    expect(() => assertNativeFileTarget('renamed-helper', pe(), { platform: 'linux', arch: 'x64' })).toThrow('Foreign native binary');
    expect(() => assertNativeFileTarget('addon.node', Buffer.from('not native'), { platform: 'linux', arch: 'x64' })).toThrow('Unrecognized native binary');
  });
  it('detects embedded foreign DLLs even inside a platform-neutral package', async () => {
    const root = await fixture({ 'node_modules/node-pty/third_party/conpty/conpty.dll': pe() });
    await expect(verifyServerPayload(root, { platform: 'linux', arch: 'x64' })).rejects.toThrow('Foreign native file');
  });
  it('rejects emitted development tests before their imports can be satisfied by ancestor dependencies', async () => {
    const root = await fixture({ 'dist/server/gateway.test.js': 'import "vitest";' });
    await expect(verifyServerPayload(root)).rejects.toThrow('Development test artifact');
  });
  it('validates intentional Electron remote assets against their labeled targets only', async () => {
    const root = await fixture({ 'dist/sidecar/native/win32-arm64/conpty.node': pe('arm64'), 'node_modules/local/pty.node': elf('x64') });
    await expect(verifyServerPayload(root, { platform: 'linux', arch: 'x64' })).rejects.toThrow('Foreign native binary');
    await expect(verifyServerPayload(root, { platform: 'linux', arch: 'x64', allowRemoteSidecarTargets: true })).resolves.toBeUndefined();
    await writeFile(path.join(root, 'dist/sidecar/native/win32-arm64/conpty.node'), pe('x64'));
    await expect(verifyServerPayload(root, { platform: 'linux', arch: 'x64', allowRemoteSidecarTargets: true })).rejects.toThrow('Foreign native binary');
  });
  it('rejects truncated native headers and preserves ordinary JavaScript/WASM assets', () => {
    expect(inspectNativeHeader(Buffer.from('MZ ordinary text'))).toBeUndefined();
    expect(() => assertNativeFileTarget('addon.node', Buffer.from('MZ!!'), { platform: 'win32', arch: 'x64' })).toThrow('Unrecognized native binary');
    expect(() => inspectNativeHeader(elf().subarray(0, 10))).toThrow('Malformed ELF');
    expect(() => assertNativeFileTarget('main.js', Buffer.from('import "node:fs";'), { platform: 'linux', arch: 'x64' })).not.toThrow();
    expect(inspectNativeHeader(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))).toBeUndefined();
  });
});
