import projection from "./native-projection.json" with { type: "json" };
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";

type Value = string | number | boolean | Uint8Array | Message | Value[];
export interface Message { readonly [key: string]: Value | undefined }
interface Field { name: string; number: number; label: number; type: number; typeName: string | null }
const messages: Readonly<Record<string, readonly Field[]>> = projection.messages;
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAXIMUM_BYTES = MAXIMUM_PROVIDER_FRAME_BYTES;

/** Bounded decoder for the reviewed descriptor projection. Unknown fields are
 * skipped according to protobuf framing; a known field with a changed wire
 * type, malformed length, duplicate scalar or unsafe integer fails closed. */
export function decodeAntigravityNativeMessage(bytes: Uint8Array, type: string): Message {
  if (bytes.byteLength > MAXIMUM_BYTES) throw new Error("antigravity_native_message_too_large");
  let fieldsLeft = 100_000;
  function decode(bytes: Uint8Array, type: string, depth: number): Message {
    const schema = messages[type];
    if (!schema || depth > 32) throw new Error("antigravity_native_schema_unavailable");
    const known = new Map(schema.map(field => [field.number, field]));
    const result: Record<string, Value> = Object.create(null);
    let position = 0;
    const varint = (): bigint => {
      let value = 0n;
      for (let i = 0; i < 10; i++) {
        const byte = bytes[position++];
        if (byte === undefined || (i === 9 && byte > 1)) throw new Error("antigravity_native_varint_invalid");
        value |= BigInt(byte & 127) << BigInt(i * 7);
        if (!(byte & 128)) return value;
      }
      throw new Error("antigravity_native_varint_invalid");
    };
    const take = (length: number): Uint8Array => {
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - position)
        throw new Error("antigravity_native_length_invalid");
      const part = bytes.subarray(position, position + length); position += length; return part;
    };
    while (position < bytes.length) {
      if (--fieldsLeft < 0) throw new Error("antigravity_native_field_limit");
      const tag = varint();
      const number = Number(tag >> 3n); const wire = Number(tag & 7n);
      if (number < 1 || number > 536_870_911) throw new Error("antigravity_native_tag_invalid");
      const field = known.get(number);
      let raw: bigint | Uint8Array;
      if (wire === 0) raw = varint();
      else if (wire === 1) raw = take(8);
      else if (wire === 2) raw = take(Number(varint()));
      else if (wire === 5) raw = take(4);
      else throw new Error("antigravity_native_wire_invalid");
      if (!field) continue;
      const expectedWire = [9, 11, 12].includes(field.type) ? 2 : field.type === 1 ? 1 : field.type === 2 ? 5 : 0;
      if (wire !== expectedWire) throw new Error("antigravity_native_field_type_changed");
      let value: Value;
      if (typeof raw === "bigint") {
        if (field.type === 8) { if (raw !== 0n && raw !== 1n) throw new Error("antigravity_native_boolean_invalid"); value = raw === 1n; }
        else { value = Number(field.type === 3 || field.type === 5 ? BigInt.asIntN(field.type === 5 ? 32 : 64, raw) : raw);
          if (!Number.isSafeInteger(value)) throw new Error("antigravity_native_integer_invalid"); }
      } else if (field.type === 9) value = decoder.decode(raw);
      else if (field.type === 12) value = Uint8Array.from(raw);
      else if (field.type === 11 && field.typeName) value = decode(raw, field.typeName, depth + 1);
      else throw new Error("antigravity_native_projection_invalid");
      if (field.label === 3) {
        const previous = result[field.name];
        if (previous === undefined) result[field.name] = [value];
        else if (Array.isArray(previous)) previous.push(value);
        else throw new Error("antigravity_native_repetition_invalid");
      } else {
        if (result[field.name] !== undefined) throw new Error("antigravity_native_duplicate_field");
        result[field.name] = value;
      }
    }
    return result;
  }
  return decode(bytes, type, 0);
}

export function message(value: Value | undefined): Message {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) ? value : {};
}
export function string(value: Value | undefined): string { return typeof value === "string" ? value : ""; }
export function integer(value: Value | undefined): number { return typeof value === "number" ? value : 0; }
export function repeated(value: Value | undefined): readonly Value[] { return Array.isArray(value) ? value : []; }
export function bytes(value: Value | undefined): Uint8Array | undefined { return value instanceof Uint8Array ? value : undefined; }
