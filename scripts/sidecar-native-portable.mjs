/** Inspect the architecture and exported Node-API version in reviewed 64-bit
 * Mach-O/PE node-pty payloads. Never infer an ABI from the packaging host. */
export function inspectSidecarPortableNative(
  bytes,
  platform,
  architecture,
  addon = true,
) {
  const invalid = () => {
    throw new Error("sidecar_native_binary_invalid");
  };
  const range = (offset, length) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > bytes.length
    )
      invalid();
    return offset;
  };
  const u16 = (offset) => bytes.readUInt16LE(range(offset, 2));
  const u32 = (offset) => bytes.readUInt32LE(range(offset, 4));
  const u64 = (offset) => Number(bytes.readBigUInt64LE(range(offset, 8)));
  const string = (offset) => {
    range(offset, 1);
    const end = bytes.indexOf(0, offset);
    if (end < 0 || end - offset > 1024) invalid();
    return bytes.toString("utf8", offset, end);
  };
  let functionOffset;
  if (platform === "darwin") {
    if (u32(0) !== 0xfeedfacf) invalid();
    if (u32(4) !== (architecture === "x64" ? 0x01000007 : 0x0100000c))
      throw new Error("sidecar_native_architecture_invalid");
    const commands = u32(16);
    if (commands > 256) invalid();
    let offset = 32;
    let symbols;
    const segments = [];
    for (let i = 0; i < commands; i++) {
      const command = u32(offset),
        size = u32(offset + 4);
      if (size < 8) invalid();
      range(offset, size);
      if (command === 2)
        symbols = {
          offset: u32(offset + 8),
          count: u32(offset + 12),
          strings: u32(offset + 16),
        };
      if (command === 0x19)
        segments.push({
          address: u64(offset + 24),
          size: u64(offset + 32),
          offset: u64(offset + 40),
          fileSize: u64(offset + 48),
        });
      offset += size;
    }
    if (addon) {
      if (!symbols || symbols.count > 100000) invalid();
      range(symbols.offset, symbols.count * 16);
      for (let i = 0; i < symbols.count; i++) {
        const entry = symbols.offset + i * 16;
        if (
          string(symbols.strings + u32(entry)) !==
          "_node_api_module_get_api_version_v1"
        )
          continue;
        const address = u64(entry + 8);
        const segment = segments.find(
          (s) => address >= s.address && address < s.address + s.fileSize,
        );
        if (!segment) invalid();
        functionOffset = segment.offset + address - segment.address;
        break;
      }
    }
  } else if (platform === "win32") {
    if (u16(0) !== 0x5a4d) invalid();
    const pe = u32(0x3c);
    if (u32(pe) !== 0x4550) invalid();
    if (u16(pe + 4) !== (architecture === "x64" ? 0x8664 : 0xaa64))
      throw new Error("sidecar_native_architecture_invalid");
    const count = u16(pe + 6),
      optionalSize = u16(pe + 20),
      optional = pe + 24;
    if (u16(optional) !== 0x20b || count > 96) invalid();
    const sections = [];
    for (let i = 0; i < count; i++) {
      const offset = optional + optionalSize + i * 40;
      sections.push({
        address: u32(offset + 12),
        size: u32(offset + 16),
        offset: u32(offset + 20),
      });
    }
    const rva = (address) => {
      const section = sections.find(
        (s) => address >= s.address && address < s.address + s.size,
      );
      if (!section) invalid();
      return range(section.offset + address - section.address, 1);
    };
    if (addon) {
      const exports = rva(u32(optional + 112));
      const count = u32(exports + 24);
      if (count > 100000) invalid();
      const names = rva(u32(exports + 32)),
        ordinals = rva(u32(exports + 36)),
        functions = rva(u32(exports + 28));
      for (let i = 0; i < count; i++) {
        if (
          string(rva(u32(names + i * 4))) ===
          "node_api_module_get_api_version_v1"
        ) {
          functionOffset = rva(u32(functions + u16(ordinals + i * 2) * 4));
          break;
        }
      }
    }
  } else invalid();
  if (!addon) return {};
  if (functionOffset === undefined) invalid();
  // This pinned dependency emits a constant-return API version function. Admit
  // only those instructions; an unknown compiler sequence requires review.
  range(functionOffset, 16);
  let offset = functionOffset;
  if (architecture === "x64") {
    if (
      bytes
        .subarray(offset, offset + 4)
        .equals(Buffer.from([0x55, 0x48, 0x89, 0xe5]))
    )
      offset += 4;
    if (bytes[offset] !== 0xb8) invalid();
    const version = u32(offset + 1);
    offset += 5;
    if (bytes[offset] === 0x5d) offset++;
    if (bytes[offset] !== 0xc3 || version < 1 || version > 10) invalid();
    return { nodeApiVersion: version };
  }
  const instruction = u32(offset);
  if (
    (instruction & 0xffe0001f) >>> 0 !== 0x52800000 ||
    u32(offset + 4) !== 0xd65f03c0
  )
    invalid();
  const version = (instruction >>> 5) & 0xffff;
  if (version < 1 || version > 10) invalid();
  return { nodeApiVersion: version };
}
