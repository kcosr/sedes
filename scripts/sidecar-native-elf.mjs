/** Inspect ELF64 little-endian dependency versions, without executing a binary. */
export function inspectSidecarNativeElf(contents, architecture) {
  const invalid = () => new Error("sidecar_native_elf_invalid");
  function range(offset, size) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > contents.length
    )
      throw invalid();
    return contents.subarray(offset, offset + size);
  }
  function uint64(offset) {
    const value = range(offset, 8).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return Number(value);
  }
  if (
    contents.length < 64 ||
    contents.subarray(0, 4).toString("hex") !== "7f454c46" ||
    contents[4] !== 2 ||
    contents[5] !== 1 ||
    contents[6] !== 1 ||
    contents.readUInt16LE(16) !== 3 ||
    !["x64", "arm64"].includes(architecture) ||
    contents.readUInt16LE(18) !== (architecture === "x64" ? 62 : 183)
  )
    throw new Error("sidecar_native_architecture_invalid");
  const sectionOffset = uint64(40);
  const sectionSize = contents.readUInt16LE(58);
  const sectionCount = contents.readUInt16LE(60);
  if (sectionSize !== 64 || sectionCount < 1 || sectionCount > 4096)
    throw invalid();
  range(sectionOffset, sectionSize * sectionCount);
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const offset = sectionOffset + index * sectionSize;
    return {
      type: contents.readUInt32LE(offset + 4),
      offset: uint64(offset + 24),
      size: uint64(offset + 32),
      link: contents.readUInt32LE(offset + 40),
    };
  });
  const versions = [];
  for (const section of sections.filter(
    (candidate) => candidate.type === 0x6ffffffe,
  )) {
    const strings = sections[section.link];
    if (strings?.type !== 3) throw invalid();
    const names = range(strings.offset, strings.size);
    const needs = range(section.offset, section.size);
    let offset = 0;
    while (offset < needs.length) {
      if (offset + 16 > needs.length || needs.readUInt16LE(offset) !== 1)
        throw invalid();
      const count = needs.readUInt16LE(offset + 2);
      const auxiliary = needs.readUInt32LE(offset + 8);
      if (count < 1 || auxiliary < 16) throw invalid();
      let cursor = offset + auxiliary;
      for (let index = 0; index < count; index += 1) {
        if (cursor + 16 > needs.length) throw invalid();
        const nameOffset = needs.readUInt32LE(cursor + 8);
        const end = names.indexOf(0, nameOffset);
        if (nameOffset >= names.length || end < nameOffset) throw invalid();
        const name = names.subarray(nameOffset, end).toString("utf8");
        if (name.startsWith("GLIBC_")) {
          if (!/^GLIBC_[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(name))
            throw new Error("sidecar_native_glibc_requirement_invalid");
          versions.push(name.slice(6));
        }
        const next = needs.readUInt32LE(cursor + 12);
        if (index < count - 1 && next < 16) throw invalid();
        if (index === count - 1 && next !== 0) throw invalid();
        cursor += next;
      }
      const next = needs.readUInt32LE(offset + 12);
      if (next === 0) break;
      if (next < 16 || offset + next + 16 > needs.length) throw invalid();
      offset += next;
    }
  }
  if (versions.length === 0)
    throw new Error("sidecar_native_glibc_requirement_missing");
  versions.sort(compareVersions);
  return { minimumGlibcVersion: versions.at(-1) };
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const comparison = (a[index] ?? 0) - (b[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
