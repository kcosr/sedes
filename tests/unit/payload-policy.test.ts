import { describe, expect, it } from "vitest";
import {
  assertBoundedSerializedPayload,
  boundText,
  boundTextTail,
  boundToolResult,
  boundValue,
  type PayloadLimits,
} from "../../src/server/conversations/payload-policy.js";

const smallLimits: PayloadLimits = {
  maximumDepth: 2,
  maximumObjectKeys: 3,
  maximumArrayEntries: 3,
  maximumStringBytes: 7,
  maximumDisplayTextBytes: 7,
  maximumArgumentBytes: 40,
  maximumResultBytes: 40,
  maximumImageBytes: 8,
  maximumNodes: 20,
  maximumStructuralBytes: 200,
};

describe("normalized payload policy", () => {
  it("uses own data properties without invoking getters", () => {
    let invoked = false;
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "safe", {
      enumerable: true,
      value: "visible",
    });
    Object.defineProperty(value, "unsafe", {
      enumerable: true,
      get() {
        invoked = true;
        return "secret";
      },
    });

    expect(boundValue(value, { limits: smallLimits })).toMatchObject({
      kind: "object",
      entries: [
        { key: { text: "safe" }, value: { text: expect.any(String) } },
        {
          key: { text: expect.any(String) },
          value: { kind: "omitted", reason: "unsupported" },
        },
      ],
    });
    expect(invoked).toBe(false);
  });

  it("redacts secrets, drops local output paths, and handles cycles/binary", () => {
    const value: Record<string, unknown> = {
      Api_Token: "never",
      fullOutputPath: "/tmp/private",
      bytes: new Uint8Array([1, 2]),
    };
    value.self = value;
    const bounded = boundValue(value);
    const serialized = JSON.stringify(bounded);
    expect(serialized).not.toContain("never");
    expect(serialized).not.toContain("/tmp/private");
    expect(serialized).toContain("sensitive_key");
    expect(serialized).toContain('"binary"');
    expect(serialized).toContain('"cycle"');
  });

  it("bounds UTF-8 at valid boundaries and marks depth truncation", () => {
    const bounded = boundValue(
      { text: "ééééé", nested: { deeper: { value: "hidden" } } },
      { limits: smallLimits },
    );
    const serialized = JSON.stringify(bounded);
    expect(serialized).toContain("…");
    expect(serialized).toContain("depth_limit");
    expect(serialized).not.toContain("hidden");
  });

  it("does not repeatedly expand shared object graphs", () => {
    const leaf = { value: "leaf" };
    const shared = Array.from({ length: 100 }, () => leaf);
    const bounded = boundValue(
      Array.from({ length: 100 }, () => shared),
      {
        limits: {
          ...smallLimits,
          maximumDepth: 8,
          maximumArrayEntries: 100,
          maximumNodes: 25,
        },
        maximumBytes: 1_000,
      },
    );
    const serialized = JSON.stringify(bounded);
    expect(serialized.length).toBeLessThan(5_000);
    expect(serialized).toContain("cycle");
  });

  it("retains a bounded UTF-8 tail without encoding the full prefix", () => {
    expect(boundTextTail(`discard-${"x".repeat(10_000)}-tail`, 8)).toEqual({
      text: "xxx-tail",
      truncation: {
        truncated: true,
        retainedBytes: 8,
        reason: "byte_limit",
      },
    });
  });

  it("omits oversized or malformed images and enforces final byte caps", () => {
    expect(
      boundToolResult(
        {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "AAAAAAAAAAAAAAAA",
            },
            {
              type: "image",
              mimeType: "image/png",
              data: "not base64",
            },
          ],
        },
        false,
        smallLimits,
      ).content,
    ).toEqual([
      {
        kind: "image_omitted",
        mimeType: "image/png",
        reason: "byte_limit",
      },
      {
        kind: "image_omitted",
        mimeType: "image/png",
        reason: "invalid_data",
      },
    ]);
    expect(() =>
      assertBoundedSerializedPayload({ value: "too long" }, 4),
    ).toThrow(/byte.limit/i);
  });

  it("caps tool-result parts at the protocol limit without invoking array getters", () => {
    let invoked = false;
    const content = Array.from({ length: 40 }, (_, index) => ({
      type: "text",
      text: String(index),
    }));
    Object.defineProperty(content, "1", {
      configurable: true,
      enumerable: true,
      get() {
        invoked = true;
        return { type: "text", text: "unsafe" };
      },
    });

    const bounded = boundToolResult(
      { content },
      false,
      {
        ...smallLimits,
        maximumArrayEntries: 100,
        maximumResultBytes: 10_000,
        maximumStringBytes: 100,
      },
    );

    expect(invoked).toBe(false);
    expect(bounded.content).toHaveLength(31);
    expect(JSON.stringify(bounded.content)).not.toContain("unsafe");
    expect(bounded.truncation).toMatchObject({
      truncated: true,
      reason: "entry_limit",
    });

    const allData = Array.from({ length: 40 }, (_, index) => ({
      type: "text",
      text: String(index),
    }));
    expect(
      boundToolResult(
        { content: allData },
        false,
        {
          ...smallLimits,
          maximumArrayEntries: 100,
          maximumResultBytes: 10_000,
          maximumStringBytes: 100,
        },
      ).content,
    ).toHaveLength(32);
  });
});

/**
 * Reference copies of the original per-code-point truncation walks. The
 * production implementations were rewritten to single whole-string encodes
 * with byte-boundary cuts; these pin byte-identical semantics.
 */
function referenceTruncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncation?: unknown } {
  const referenceEncoder = new TextEncoder();
  if (maximumBytes <= 0) {
    return {
      text: "",
      truncation: { truncated: true, retainedBytes: 0, reason: "byte_limit" },
    };
  }
  const codePoints: string[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for (const codePoint of value) {
    const codePointBytes = referenceEncoder.encode(codePoint).byteLength;
    if (retainedBytes + codePointBytes > maximumBytes) {
      truncated = true;
      break;
    }
    codePoints.push(codePoint);
    retainedBytes += codePointBytes;
  }
  if (!truncated) return { text: value };
  const suffix = "…";
  const suffixBytes = referenceEncoder.encode(suffix).byteLength;
  while (
    codePoints.length > 0 &&
    retainedBytes + suffixBytes > maximumBytes
  ) {
    retainedBytes -= referenceEncoder.encode(codePoints.pop()!).byteLength;
  }
  const text =
    codePoints.join("") + (maximumBytes >= suffixBytes ? suffix : "");
  return {
    text,
    truncation: {
      truncated: true,
      retainedBytes: referenceEncoder.encode(text).byteLength,
      reason: "byte_limit",
    },
  };
}

function referenceTextTail(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncation?: unknown } {
  const referenceEncoder = new TextEncoder();
  if (maximumBytes <= 0) {
    return {
      text: "",
      truncation: { truncated: true, retainedBytes: 0, reason: "byte_limit" },
    };
  }
  const reversed: string[] = [];
  let retainedBytes = 0;
  let cursor = value.length;
  while (cursor > 0) {
    let start = cursor - 1;
    const codeUnit = value.charCodeAt(start);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
      const previous = value.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
    }
    const codePoint = value.slice(start, cursor);
    const bytes = referenceEncoder.encode(codePoint).byteLength;
    if (retainedBytes + bytes > maximumBytes) break;
    reversed.push(codePoint);
    retainedBytes += bytes;
    cursor = start;
  }
  if (cursor === 0) return { text: value };
  const suffix = reversed.reverse().join("");
  return {
    text: suffix,
    truncation: { truncated: true, retainedBytes, reason: "byte_limit" },
  };
}

describe("UTF-8 truncation byte-equivalence", () => {
  const values = [
    "",
    "a",
    "ascii only text",
    "é",
    "ééé",
    "aéb",
    "emoji \u{1F600} mix \u{1F389} done",
    "\u{1F600}\u{1F600}\u{1F600}",
    "combining é suffix",
    "lone replacement",
    "lone high surrogate \uD800 end",
    "\uD800lone high surrogate start",
    "lone \uDC00 low surrogate",
    "paired \uD83D\uDE00 then lone \uD800",
    "x".repeat(10_000),
    `mixed ${"é".repeat(500)} tail`,
  ];
  const budgets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 64, 1_024];
  for (const value of values) {
    for (const maximumBytes of budgets) {
      it(`truncates identically to the code-point walks (${JSON.stringify(value.slice(0, 16))}, ${value.length} units @ ${maximumBytes})`, () => {
        expect(boundText(value, maximumBytes)).toEqual(
          referenceTruncateUtf8(value, maximumBytes),
        );
        expect(boundTextTail(value, maximumBytes)).toEqual(
          referenceTextTail(value, maximumBytes),
        );
      });
    }
  }
});
