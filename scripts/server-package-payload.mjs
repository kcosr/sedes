import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

const nativeExtension = /\.(?:node|exe|dll|dylib|so(?:\.\d+)*)$/iu;
const machine = (value, kind) => {
  const values = kind === 'elf' ? { 62: 'x64', 183: 'arm64' } : kind === 'pe' ? { 34404: 'x64', 43620: 'arm64' } : { 16777223: 'x64', 16777228: 'arm64' };
  return values[value] ?? `unsupported-${kind}-${value}`;
};

/** Read architecture identities only; loaders still validate ABI/runtime behavior. */
export function inspectNativeHeader(bytes) {
  if (bytes.length < 4) return undefined;
  const big = bytes.readUInt32BE(0), little = bytes.readUInt32LE(0);
  if (big === 0x7f454c46) {
    if (bytes.length < 20 || ![1, 2].includes(bytes[5])) throw new Error('Malformed ELF header');
    return { platform: 'linux', architectures: [machine(bytes[5] === 1 ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18), 'elf')] };
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    // "MZ" alone can begin ordinary text. Only a DOS header pointing to the
    // actual PE signature identifies a Windows executable.
    if (bytes.length < 64) return undefined;
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x00004550) return undefined;
    return { platform: 'win32', architectures: [machine(bytes.readUInt16LE(offset + 4), 'pe')] };
  }
  if ([0xfeedface, 0xfeedfacf].includes(big) || [0xfeedface, 0xfeedfacf].includes(little)) {
    if (bytes.length < 8) throw new Error('Malformed Mach-O header');
    return { platform: 'darwin', architectures: [machine([0xfeedface, 0xfeedfacf].includes(little) ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4), 'mach')] };
  }
  if ([0xcafebabe, 0xcafebabf].includes(big) || [0xcafebabe, 0xcafebabf].includes(little)) {
    const read = [0xcafebabe, 0xcafebabf].includes(big) ? offset => bytes.readUInt32BE(offset) : offset => bytes.readUInt32LE(offset);
    if (bytes.length < 8) throw new Error('Malformed universal Mach-O header');
    const count = read(4), stride = read(0) === 0xcafebabf ? 32 : 20;
    if (count < 1 || count > 32 || bytes.length < 8 + count * stride) throw new Error('Malformed universal Mach-O header');
    return { platform: 'darwin', architectures: Array.from({ length: count }, (_, index) => machine(read(8 + index * stride), 'mach')) };
  }
  return undefined;
}

export function assertNativeFileTarget(filename, bytes, target) {
  if ((/\.(?:exe|dll)$/iu.test(filename) && target.platform !== 'win32') || (/\.dylib$/iu.test(filename) && target.platform !== 'darwin') || (/\.so(?:\.\d+)*$/iu.test(filename) && target.platform !== 'linux')) throw new Error(`Foreign native file: ${filename}`);
  const native = inspectNativeHeader(bytes);
  if (!native && nativeExtension.test(filename)) throw new Error(`Unrecognized native binary: ${filename}`);
  if (native && (native.platform !== target.platform || !native.architectures.includes(target.arch))) throw new Error(`Foreign native binary: ${filename} (${native.platform}/${native.architectures.join(',')}, expected ${target.platform}/${target.arch})`);
}

/** Audit embedded binaries as well as package-level optional dependency metadata. */
export async function verifyServerPayload(root, { platform = process.platform, arch = process.arch, allowRemoteSidecarTargets = false } = {}) {
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(filename, relative); continue; }
      // Package integrity checks separately validate relative symlinks. Native
      // payloads are inspected through their real files, without following links.
      if (!entry.isFile()) continue;
      if (relative.startsWith('dist/') && /\.test\.[cm]?js$/u.test(relative)) throw new Error(`Development test artifact: ${relative}`);
      let target = { platform, arch };
      const remote = /^dist\/sidecar\/native\/(linux|darwin|win32)-(x64|arm64)\//u.exec(relative);
      if (allowRemoteSidecarTargets && remote) target = { platform: remote[1], arch: remote[2] };
      const handle = await open(filename, 'r');
      try {
        let header = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        header = header.subarray(0, bytesRead);
        // PE's signature can follow a larger DOS stub; bound that offset before
        // reading more rather than loading an entire executable into memory.
        if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
          const required = header.readUInt32LE(60) + 6;
          if (required <= 1024 * 1024 && required > header.length) {
            header = Buffer.alloc(required);
            const result = await handle.read(header, 0, required, 0);
            header = header.subarray(0, result.bytesRead);
          }
        }
        assertNativeFileTarget(relative, header, target);
      } finally { await handle.close(); }
    }
  }
  await walk(root);
}
