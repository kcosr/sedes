import { describe, expect, it, vi } from "vitest";

import {
  BoundedJsonSnapshotError,
  snapshotBoundedJson,
  type BoundedJsonSnapshotErrorCode,
} from "../../src/server/provider-protocol/json/bounded-json-snapshot.js";

function expectCode(
  action: () => unknown,
  code: BoundedJsonSnapshotErrorCode,
): void {
  try {
    action();
    throw new Error("expected snapshot failure");
  } catch (error) {
    expect(error).toBeInstanceOf(BoundedJsonSnapshotError);
    expect((error as BoundedJsonSnapshotError).code).toBe(code);
    expect((error as Error).message).not.toContain("secret");
  }
}

describe("bounded provider JSON snapshot", () => {
  it("creates fresh deeply frozen arrays and null-prototype objects", () => {
    const nested = Object.create(null) as Record<string, unknown>;
    nested.answer = 42.5;
    const source = { values: [null, true, "text", nested] };

    const snapshot = snapshotBoundedJson(source) as Record<string, unknown>;
    const values = snapshot.values as readonly unknown[];

    expect(snapshot).not.toBe(source);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.getPrototypeOf(values[3] as object)).toBeNull();
    expect(snapshot).toEqual(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(values[3])).toBe(true);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(source);
  });

  it("never invokes stateful accessors", () => {
    let reads = 0;
    const source = {} as Record<string, unknown>;
    Object.defineProperty(source, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "secret-value";
      },
    });

    expectCode(() => snapshotBoundedJson(source), "accessor_property");
    expect(reads).toBe(0);
  });

  it("does not invoke or retain non-enumerable toJSON behavior", () => {
    const toJSON = vi.fn(() => {
      throw new Error("secret toJSON invoked");
    });
    const source = { safe: true };
    Object.defineProperty(source, "toJSON", {
      enumerable: false,
      value: toJSON,
    });

    const snapshot = snapshotBoundedJson(source);
    expect(JSON.stringify(snapshot)).toBe('{"safe":true}');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects custom prototypes without invoking inherited toJSON", () => {
    const inheritedToJSON = vi.fn(() => {
      throw new Error("secret inherited behavior");
    });
    const prototype = { toJSON: inheritedToJSON };
    const source = Object.create(prototype) as Record<string, unknown>;
    source.safe = true;

    expectCode(() => snapshotBoundedJson(source), "non_plain_object");
    expect(inheritedToJSON).not.toHaveBeenCalled();
  });

  it("rejects proxies before invoking their traps", () => {
    const getOwnPropertyDescriptor = vi.fn(() => {
      throw new Error("secret proxy trap");
    });
    const source = new Proxy({}, { getOwnPropertyDescriptor });

    expectCode(() => snapshotBoundedJson(source), "non_plain_object");
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  it("rejects cycles while permitting repeated acyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectCode(() => snapshotBoundedJson(cyclic), "cycle");

    const shared = { value: "ok" };
    const snapshot = snapshotBoundedJson([shared, shared]) as readonly object[];
    expect(snapshot[0]).toEqual(snapshot[1]);
    expect(snapshot[0]).not.toBe(snapshot[1]);
  });

  it.each([undefined, 1n, Symbol("secret"), () => "secret"])(
    "rejects unsupported JSON values",
    (value) => {
      expectCode(() => snapshotBoundedJson(value), "unsupported_value");
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite numbers",
    (value) => {
      expectCode(() => snapshotBoundedJson(value), "non_finite_number");
    },
  );

  it("preserves finite JSON numbers and canonicalizes negative zero to its wire value", () => {
    const values = [-0, 0.125, Number.MAX_SAFE_INTEGER + 2, 1e100];
    const snapshot = snapshotBoundedJson(values) as readonly number[];
    expect(Object.is(snapshot[0], 0)).toBe(true);
    expect(snapshot.slice(1)).toEqual(values.slice(1));
  });

  it("rejects symbol keys, sparse arrays, and enumerable array extensions", () => {
    expectCode(
      () => snapshotBoundedJson({ [Symbol("secret")]: true }),
      "symbol_property",
    );
    expectCode(() => snapshotBoundedJson(new Array(1)), "sparse_array");
    const extended = [1] as unknown[] & { extra?: boolean };
    extended.extra = true;
    expectCode(() => snapshotBoundedJson(extended), "non_json_array_property");
  });

  it("preserves prototype-shaped own keys without prototype mutation", () => {
    const source = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });

    const snapshot = snapshotBoundedJson(source) as Record<string, unknown>;
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(snapshot.__proto__).toEqual({ polluted: true });
    expect(JSON.stringify(snapshot)).toBe('{"__proto__":{"polluted":true}}');
  });

  it("enforces depth, node, collection, and raw UTF-8 string bounds", () => {
    expectCode(
      () => snapshotBoundedJson({ nested: true }, { maximumDepth: 0 }),
      "depth_exceeded",
    );
    expectCode(
      () => snapshotBoundedJson([1, 2], { maximumTotalNodes: 2 }),
      "total_nodes_exceeded",
    );
    expectCode(
      () => snapshotBoundedJson([1, 2], { maximumArrayItems: 1 }),
      "array_items_exceeded",
    );
    expectCode(
      () =>
        snapshotBoundedJson(
          { first: 1, second: 2 },
          {
            maximumObjectProperties: 1,
          },
        ),
      "object_properties_exceeded",
    );
    expectCode(
      () => snapshotBoundedJson("😀", { maximumStringBytes: 3 }),
      "string_bytes_exceeded",
    );
  });

  it("bounds ignored non-enumerable properties on objects and arrays", () => {
    const object = { visible: true };
    Object.defineProperty(object, "hidden", { value: "safe" });
    expectCode(
      () => snapshotBoundedJson(object, { maximumObjectProperties: 1 }),
      "object_properties_exceeded",
    );

    const array = [true];
    Object.defineProperty(array, "firstHidden", { value: "safe" });
    Object.defineProperty(array, "secondHidden", { value: "safe" });
    expectCode(
      () => snapshotBoundedJson(array, { maximumObjectProperties: 1 }),
      "object_properties_exceeded",
    );
  });

  it("computes the exact encoded UTF-8 budget for escaped and lone-surrogate strings", () => {
    const source = { 'q"\\\n😀': "\ud800\t" };
    const encodedBytes = Buffer.byteLength(JSON.stringify(source), "utf8");
    const snapshot = snapshotBoundedJson(source, {
      maximumEncodedBytes: encodedBytes,
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBe(
      encodedBytes,
    );
    expectCode(
      () =>
        snapshotBoundedJson(source, {
          maximumEncodedBytes: encodedBytes - 1,
        }),
      "encoded_bytes_exceeded",
    );
  });

  it("matches JSON.stringify byte accounting across a deterministic UTF-16 corpus", () => {
    let state = 0x6d2b79f5;
    const next = (): number => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return (state ^ (state >>> 14)) >>> 0;
    };
    const codeUnits = [
      0x00, 0x08, 0x0a, 0x1f, 0x20, 0x22, 0x5c, 0x7f, 0x80, 0x7ff, 0x800,
      0x2028, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff,
    ];
    const corpus = ["", ...codeUnits.map((code) => String.fromCharCode(code))];
    for (let sample = 0; sample < 200; sample += 1) {
      const length = next() % 40;
      let value = "";
      for (let index = 0; index < length; index += 1) {
        value += String.fromCharCode(codeUnits[next() % codeUnits.length] ?? 0);
      }
      corpus.push(value);
    }

    for (const value of corpus) {
      const expectedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      const snapshot = snapshotBoundedJson(value, {
        maximumEncodedBytes: expectedBytes,
      });
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBe(
        expectedBytes,
      );
      expectCode(
        () =>
          snapshotBoundedJson(value, {
            maximumEncodedBytes: expectedBytes - 1,
          }),
        expectedBytes === 1 ? "invalid_limits" : "encoded_bytes_exceeded",
      );

      const keyed = { [value]: null };
      const keyedBytes = Buffer.byteLength(JSON.stringify(keyed), "utf8");
      const keyedSnapshot = snapshotBoundedJson(keyed, {
        maximumEncodedBytes: keyedBytes,
      });
      expect(Buffer.byteLength(JSON.stringify(keyedSnapshot), "utf8")).toBe(
        keyedBytes,
      );
      expectCode(
        () =>
          snapshotBoundedJson(keyed, {
            maximumEncodedBytes: keyedBytes - 1,
          }),
        "encoded_bytes_exceeded",
      );
    }
  });

  it("rejects aggregate payload growth when each string is individually valid", () => {
    const source = Array.from({ length: 100 }, () => "x".repeat(20));
    expectCode(
      () =>
        snapshotBoundedJson(source, {
          maximumArrayItems: 100,
          maximumEncodedBytes: 1_000,
          maximumStringBytes: 20,
        }),
      "encoded_bytes_exceeded",
    );
  });

  it("charges enormous metadata keys against the wire budget", () => {
    const metadata = Object.create(null) as Record<string, unknown>;
    metadata["k".repeat(20_000)] = true;
    expectCode(
      () =>
        snapshotBoundedJson(metadata, {
          maximumEncodedBytes: 1_000,
          maximumStringBytes: 20_000,
        }),
      "encoded_bytes_exceeded",
    );
  });

  it("returns closed deterministic errors without source values", () => {
    let first: BoundedJsonSnapshotError | undefined;
    let second: BoundedJsonSnapshotError | undefined;
    for (const assign of [
      (error: BoundedJsonSnapshotError) => {
        first = error;
      },
      (error: BoundedJsonSnapshotError) => {
        second = error;
      },
    ]) {
      try {
        snapshotBoundedJson({ token: "secret", bad: undefined });
      } catch (error) {
        assign(error as BoundedJsonSnapshotError);
      }
    }
    expect(first?.code).toBe("unsupported_value");
    expect(first?.message).toBe(second?.message);
    expect(first?.message).not.toContain("secret");
    expect(first).not.toHaveProperty("cause");
  });
});
