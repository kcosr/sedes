import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// Qualification-time provenance check only. Runtime admission intentionally does
// not hash or extract the executable, and no provider process is launched here.
const executable = process.argv[2];
const refresh = process.argv[3] === "--refresh-provenance";
if (!executable || !path.isAbsolute(executable) || process.argv.length !== (refresh ? 4 : 3)) {
  throw new Error("Usage: node scripts/antigravity/check-native-projection.mjs /absolute/path/to/reviewed/agy [--refresh-provenance]");
}
if ((await stat(executable)).size > 512 * 1024 * 1024) throw new Error("The qualification artifact exceeds 512 MiB.");
const binary = await readFile(executable);
const projection = JSON.parse(await readFile(new URL("../../src/server/backends/antigravity/native-projection.json", import.meta.url), "utf8"));
const files = new Map(), messages = new Map();

function field(bytes, offset) {
  let position = offset;
  function varint() {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = bytes[position++];
      if (byte === undefined || index === 9 && byte > 1) throw new Error("Invalid descriptor varint");
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) { const numeric = Number(value); if (!Number.isSafeInteger(numeric)) throw new Error("Unsafe descriptor integer"); return numeric; }
    }
    throw new Error("Invalid descriptor varint");
  }
  const key = varint(), number = Math.floor(key / 8), wire = key & 7;
  if (!number) throw new Error("Invalid descriptor tag");
  let value;
  if (wire === 0) value = varint();
  else {
    const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || length > bytes.length - position) throw new Error("Invalid descriptor length");
    value = bytes.subarray(position, position + length); position += length;
  }
  return { number, wire, value, position };
}
function fields(bytes) {
  const values = []; let position = 0;
  while (position < bytes.length) { const next = field(bytes, position); position = next.position; values.push(next); }
  return values;
}
function first(values, number) {
  const value = values.find(value => value.number === number)?.value;
  return Buffer.isBuffer(value) ? new TextDecoder("utf8", { fatal: true }).decode(value) : value;
}
function collect(bytes, prefix, depth = 0) {
  if (depth > 32) throw new Error("Descriptor nesting limit");
  const values = fields(bytes), name = `${prefix}.${first(values, 1)}`;
  const definitions = values.filter(value => value.number === 2).map(({ value }) => {
    const fields = parseFields(value);
    return { name: first(fields, 1), number: first(fields, 3), label: first(fields, 4), type: first(fields, 5), typeName: first(fields, 6) ?? null };
  });
  messages.set(name, definitions);
  for (const value of values.filter(value => value.number === 3)) collect(value.value, name, depth + 1);
}
const parseFields = fields;
const marker = Buffer.from(".proto\x12");
let search = 0;
while ((search = binary.indexOf(marker, search)) !== -1) {
  const end = search + 6; search += marker.length;
  for (let start = Math.max(0, end - 256); start < end - 6; start++) {
    if (binary[start] !== 10) continue;
    try {
      const head = field(binary, start);
      if (head.position !== end || !Buffer.isBuffer(head.value) || !head.value.toString().endsWith(".proto")) continue;
      let position = start; const values = [];
      while (position - start < 8 * 1024 * 1024) {
        let next;
        try { next = field(binary, position); } catch { break; }
        if (next.number < 1 || next.number > 14 || next.number === 13 ||
          (next.number === 14 ? next.wire !== 0 : [10, 11].includes(next.number) ? ![0, 2].includes(next.wire) : next.wire !== 2)) break;
        if (![3, 4, 5, 6, 7, 10, 11].includes(next.number) && values.some(value => value.number === next.number)) break;
        values.push(next); position = next.position;
      }
      if (first(values, 12) !== undefined && !["proto3", "proto2", "editions"].includes(first(values, 12))) continue;
      const packageName = first(values, 2);
      if (typeof packageName !== "string") continue;
      files.set(head.value.toString(), { name: head.value.toString(), package: packageName,
        sha256: createHash("sha256").update(binary.subarray(start, position)).digest("hex"), length: position - start });
      for (const value of values.filter(value => value.number === 4)) collect(value.value, `.${packageName}`);
      break;
    } catch { /* Other binary strings are not FileDescriptorProto boundaries. */ }
  }
}
const errors = [];
for (const expected of projection.source.descriptorFiles) {
  const actual = files.get(expected.name);
  if (refresh && actual) { Object.assign(expected, actual); continue; }
  if (!actual || actual.sha256 !== expected.sha256 || actual.length !== expected.length || actual.package !== expected.package)
    errors.push(`Descriptor provenance mismatch: ${expected.name} (expected ${expected.length}/${expected.sha256}, found ${actual?.length}/${actual?.sha256})`);
}
for (const [name, expected] of Object.entries(projection.messages)) {
  const actual = messages.get(name);
  for (const value of expected) {
    const found = actual?.find(field => field.number === value.number);
    if (!found || JSON.stringify(found) !== JSON.stringify(value)) errors.push(`Projected field mismatch: ${name}.${value.name} (${value.number})`);
  }
}
if (errors.length) throw new Error(errors.join("\n"));
if (refresh) await writeFile(new URL("../../src/server/backends/antigravity/native-projection.json", import.meta.url), `${JSON.stringify(projection, null, 2)}\n`);
console.log(`Verified ${Object.keys(projection.messages).length} native message projections and ${projection.source.descriptorFiles.length} descriptor hashes for the reviewed Antigravity ${projection.source.agentVersion} artifact.`);
