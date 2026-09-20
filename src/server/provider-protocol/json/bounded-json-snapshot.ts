import { types as nodeTypes } from "node:util";

export type BoundedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BoundedJsonValue[]
  | { readonly [key: string]: BoundedJsonValue };

export interface BoundedJsonSnapshotLimits {
  readonly maximumDepth: number;
  readonly maximumObjectProperties: number;
  readonly maximumArrayItems: number;
  readonly maximumStringBytes: number;
  readonly maximumTotalNodes: number;
  readonly maximumEncodedBytes: number;
}

export type BoundedJsonSnapshotErrorCode =
  | "accessor_property"
  | "array_items_exceeded"
  | "cycle"
  | "depth_exceeded"
  | "encoded_bytes_exceeded"
  | "invalid_limits"
  | "non_finite_number"
  | "non_json_array_property"
  | "non_plain_object"
  | "object_properties_exceeded"
  | "sparse_array"
  | "string_bytes_exceeded"
  | "symbol_property"
  | "total_nodes_exceeded"
  | "unsupported_value";

const ERROR_MESSAGES: Readonly<Record<BoundedJsonSnapshotErrorCode, string>> =
  Object.freeze({
    accessor_property: "JSON snapshot contains an accessor property.",
    array_items_exceeded: "JSON snapshot array item limit exceeded.",
    cycle: "JSON snapshot contains a cycle.",
    depth_exceeded: "JSON snapshot depth limit exceeded.",
    encoded_bytes_exceeded: "JSON snapshot encoded byte limit exceeded.",
    invalid_limits: "JSON snapshot limits are invalid.",
    non_finite_number: "JSON snapshot contains a non-finite number.",
    non_json_array_property:
      "JSON snapshot array contains a non-JSON property.",
    non_plain_object: "JSON snapshot contains a non-plain object.",
    object_properties_exceeded: "JSON snapshot object property limit exceeded.",
    sparse_array: "JSON snapshot contains a sparse array.",
    string_bytes_exceeded: "JSON snapshot string byte limit exceeded.",
    symbol_property: "JSON snapshot contains a symbol property.",
    total_nodes_exceeded: "JSON snapshot node limit exceeded.",
    unsupported_value: "JSON snapshot contains an unsupported value.",
  });

export class BoundedJsonSnapshotError extends Error {
  readonly code: BoundedJsonSnapshotErrorCode;

  constructor(code: BoundedJsonSnapshotErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BoundedJsonSnapshotError";
    this.code = code;
  }
}

export const DEFAULT_BOUNDED_JSON_SNAPSHOT_LIMITS: BoundedJsonSnapshotLimits =
  Object.freeze({
    maximumDepth: 32,
    maximumObjectProperties: 4_096,
    maximumArrayItems: 65_536,
    maximumStringBytes: 1_048_576,
    maximumTotalNodes: 100_000,
    maximumEncodedBytes: 8_388_608,
  });

interface EncodedStringSize {
  readonly rawBytes: number;
  readonly encodedContentBytes: number;
}

function fail(code: BoundedJsonSnapshotErrorCode): never {
  throw new BoundedJsonSnapshotError(code);
}

function validateLimit(value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail("invalid_limits");
  }
}

function resolveLimits(
  supplied: Partial<BoundedJsonSnapshotLimits> | undefined,
): BoundedJsonSnapshotLimits {
  const limits: BoundedJsonSnapshotLimits = {
    ...DEFAULT_BOUNDED_JSON_SNAPSHOT_LIMITS,
    ...supplied,
  };
  validateLimit(limits.maximumDepth, true);
  validateLimit(limits.maximumObjectProperties, true);
  validateLimit(limits.maximumArrayItems, true);
  validateLimit(limits.maximumStringBytes, true);
  validateLimit(limits.maximumTotalNodes, false);
  validateLimit(limits.maximumEncodedBytes, false);
  return limits;
}

/** Returns the exact UTF-8 sizes used by well-formed JSON.stringify strings. */
function measureString(value: string): EncodedStringSize {
  let rawBytes = 0;
  let encodedContentBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) {
      rawBytes += 1;
      encodedContentBytes +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
      continue;
    }
    if (code === 0x22 || code === 0x5c) {
      rawBytes += 1;
      encodedContentBytes += 2;
      continue;
    }
    if (code <= 0x7f) {
      rawBytes += 1;
      encodedContentBytes += 1;
      continue;
    }
    if (code <= 0x7ff) {
      rawBytes += 2;
      encodedContentBytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        rawBytes += 4;
        encodedContentBytes += 4;
        index += 1;
      } else {
        rawBytes += 3;
        encodedContentBytes += 6;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      rawBytes += 3;
      encodedContentBytes += 6;
      continue;
    }
    rawBytes += 3;
    encodedContentBytes += 3;
  }
  return { rawBytes, encodedContentBytes };
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "") {
    return false;
  }
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

class SnapshotBuilder {
  readonly #limits: BoundedJsonSnapshotLimits;
  readonly #ancestors = new Set<object>();
  #nodes = 0;
  #encodedBytes = 0;

  constructor(limits: BoundedJsonSnapshotLimits) {
    this.#limits = limits;
  }

  snapshot(value: unknown): BoundedJsonValue {
    return this.#visit(value, 0);
  }

  #addEncodedBytes(bytes: number): void {
    if (bytes > this.#limits.maximumEncodedBytes - this.#encodedBytes) {
      fail("encoded_bytes_exceeded");
    }
    this.#encodedBytes += bytes;
  }

  #assertMinimumEncodedBytes(bytes: number): void {
    if (bytes > this.#limits.maximumEncodedBytes - this.#encodedBytes) {
      fail("encoded_bytes_exceeded");
    }
  }

  #countNode(): void {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maximumTotalNodes) {
      fail("total_nodes_exceeded");
    }
  }

  #assertMinimumChildNodes(count: number): void {
    if (count > this.#limits.maximumTotalNodes - this.#nodes) {
      fail("total_nodes_exceeded");
    }
  }

  #measureBoundedString(value: string): EncodedStringSize {
    const size = measureString(value);
    if (size.rawBytes > this.#limits.maximumStringBytes) {
      fail("string_bytes_exceeded");
    }
    return size;
  }

  #visit(value: unknown, depth: number): BoundedJsonValue {
    if (depth > this.#limits.maximumDepth) {
      fail("depth_exceeded");
    }
    this.#countNode();

    if (value === null) {
      this.#addEncodedBytes(4);
      return null;
    }
    if (typeof value === "boolean") {
      this.#addEncodedBytes(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("non_finite_number");
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        fail("unsupported_value");
      }
      this.#addEncodedBytes(encoded.length);
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      const size = this.#measureBoundedString(value);
      this.#addEncodedBytes(size.encodedContentBytes + 2);
      return value;
    }
    if (typeof value !== "object") {
      fail("unsupported_value");
    }
    if (nodeTypes.isProxy(value)) {
      fail("non_plain_object");
    }
    if (this.#ancestors.has(value)) {
      fail("cycle");
    }

    this.#ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return this.#visitArray(value, depth);
      }
      return this.#visitObject(value, depth);
    } finally {
      this.#ancestors.delete(value);
    }
  }

  #visitArray(value: readonly unknown[], depth: number): BoundedJsonValue {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("non_plain_object");
    }
    const length = value.length;
    if (length > this.#limits.maximumArrayItems) {
      fail("array_items_exceeded");
    }

    let indexedProperties = 0;
    let auxiliaryProperties = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        fail("symbol_property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        fail("unsupported_value");
      }
      if (!("value" in descriptor)) {
        fail("accessor_property");
      }
      if (key === "length") {
        continue;
      }
      if (isArrayIndex(key, length)) {
        indexedProperties += 1;
        continue;
      }
      auxiliaryProperties += 1;
      if (auxiliaryProperties > this.#limits.maximumObjectProperties) {
        fail("object_properties_exceeded");
      }
      this.#measureBoundedString(key);
      if (descriptor.enumerable) {
        fail("non_json_array_property");
      }
    }
    if (indexedProperties !== length) {
      fail("sparse_array");
    }

    this.#assertMinimumChildNodes(length);
    const structuralBytes = 2 + Math.max(0, length - 1);
    this.#assertMinimumEncodedBytes(structuralBytes + length);
    this.#addEncodedBytes(structuralBytes);

    const snapshot = new Array<BoundedJsonValue>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        fail("unsupported_value");
      }
      snapshot[index] = this.#visit(descriptor.value, depth + 1);
    }
    return Object.freeze(snapshot);
  }

  #visitObject(value: object, depth: number): BoundedJsonValue {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("non_plain_object");
    }

    const keys = Reflect.ownKeys(value);
    let ownProperties = 0;
    let enumerableProperties = 0;
    let structuralBytes = 2;
    for (const key of keys) {
      if (typeof key === "symbol") {
        fail("symbol_property");
      }
      ownProperties += 1;
      if (ownProperties > this.#limits.maximumObjectProperties) {
        fail("object_properties_exceeded");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        fail("unsupported_value");
      }
      if (!("value" in descriptor)) {
        fail("accessor_property");
      }
      const keySize = this.#measureBoundedString(key);
      if (!descriptor.enumerable) {
        continue;
      }
      enumerableProperties += 1;
      structuralBytes += keySize.encodedContentBytes + 3;
    }
    structuralBytes += Math.max(0, enumerableProperties - 1);
    this.#assertMinimumChildNodes(enumerableProperties);
    this.#assertMinimumEncodedBytes(structuralBytes + enumerableProperties);
    this.#addEncodedBytes(structuralBytes);

    const snapshot: Record<string, BoundedJsonValue> = Object.create(
      null,
    ) as Record<string, BoundedJsonValue>;
    for (const key of keys) {
      if (typeof key !== "string") {
        fail("symbol_property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        continue;
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: this.#visit(descriptor.value, depth + 1),
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  }
}

/**
 * Creates a deeply frozen JSON snapshot without invoking input accessors,
 * prototypes, or `toJSON`. The encoded-byte bound is exact for one subsequent
 * `JSON.stringify` of the returned value.
 */
export function snapshotBoundedJson(
  value: unknown,
  limits?: Partial<BoundedJsonSnapshotLimits>,
): BoundedJsonValue {
  return new SnapshotBuilder(resolveLimits(limits)).snapshot(value);
}
