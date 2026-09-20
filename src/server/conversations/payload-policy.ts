import type {
  AllowedImageMime,
  BoundedDisplayText,
  BoundedText,
  BoundedToolResult,
  BoundedValue,
  MessageText,
  TruncationInfo,
} from "../../shared/protocol/payload.js";
import {
  MAXIMUM_BROWSER_ENTITY_BYTES,
  MAXIMUM_MESSAGE_TEXT_BYTES,
  PAYLOAD_LIMITS,
} from "../../shared/protocol/payload.js";

export interface PayloadLimits {
  readonly maximumDepth: number;
  readonly maximumObjectKeys: number;
  readonly maximumArrayEntries: number;
  readonly maximumStringBytes: number;
  readonly maximumDisplayTextBytes: number;
  readonly maximumArgumentBytes: number;
  readonly maximumResultBytes: number;
  readonly maximumImageBytes: number;
  readonly maximumNodes: number;
  readonly maximumStructuralBytes: number;
}

export const DEFAULT_PAYLOAD_LIMITS: PayloadLimits = {
  maximumDepth: 8,
  maximumObjectKeys: 80,
  maximumArrayEntries: 100,
  maximumStringBytes: 16_384,
  maximumDisplayTextBytes: 4_096,
  maximumArgumentBytes: 64 * 1_024,
  maximumResultBytes: 128 * 1_024,
  maximumImageBytes: 256 * 1_024,
  maximumNodes: 2_000,
  maximumStructuralBytes: 64 * 1_024,
};

export const MAXIMUM_BROWSER_ITEM_BYTES = MAXIMUM_BROWSER_ENTITY_BYTES;

/** Preserve authoritative chat text exactly within the message contract. */
export function preserveMessageText(value: string): MessageText {
  const result = { text: value };
  assertBoundedSerializedPayload(result, MAXIMUM_MESSAGE_TEXT_BYTES);
  return result;
}

const allowedImageMimes = new Set<AllowedImageMime>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

const ELLIPSIS = "…";
/** UTF-8 byte length of U+2026 HORIZONTAL ELLIPSIS. */
const ELLIPSIS_BYTES = 3;

/** Lone (unpaired) surrogate: high not followed by low, or low not preceded by high. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

// Code-point walks retained for strings with lone surrogates: the byte-cut
// paths decode through TextDecoder, which replaces unpaired surrogates with
// U+FFFD, while the original walks preserve them. Malformed input is rare,
// so it pays the per-code-point cost and keeps byte-exact legacy output.
function truncateUtf8CodePointWalk(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncation?: TruncationInfo } {
  const codePoints: string[] = [];
  let retainedBytes = 0;
  let truncated = false;
  for (const codePoint of value) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (retainedBytes + codePointBytes > maximumBytes) {
      truncated = true;
      break;
    }
    codePoints.push(codePoint);
    retainedBytes += codePointBytes;
  }
  if (!truncated) {
    return { text: value };
  }
  while (
    codePoints.length > 0 &&
    retainedBytes + ELLIPSIS_BYTES > maximumBytes
  ) {
    retainedBytes -= encoder.encode(codePoints.pop()!).byteLength;
  }
  const text =
    codePoints.join("") + (maximumBytes >= ELLIPSIS_BYTES ? ELLIPSIS : "");
  return {
    text,
    truncation: {
      truncated: true,
      retainedBytes: utf8Bytes(text),
      reason: "byte_limit",
    },
  };
}

function textTailCodePointWalk(
  value: string,
  maximumBytes: number,
): BoundedText {
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
    const bytes = encoder.encode(codePoint).byteLength;
    if (retainedBytes + bytes > maximumBytes) break;
    reversed.push(codePoint);
    retainedBytes += bytes;
    cursor = start;
  }
  if (cursor === 0) return { text: value };
  return {
    text: reversed.reverse().join(""),
    truncation: {
      truncated: true,
      retainedBytes,
      reason: "byte_limit",
    },
  };
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncation?: TruncationInfo } {
  if (maximumBytes <= 0) {
    return {
      text: "",
      truncation: {
        truncated: true,
        retainedBytes: 0,
        reason: "byte_limit",
      },
    };
  }
  // One whole-string encode instead of one encode per code point: the
  // previous walk cost ~5.7s per full Codex history projection on large
  // threads (every projected string ran it). The cut below reproduces that
  // walk exactly — the maximal code-point prefix whose byte length leaves
  // room for the ellipsis.
  if (LONE_SURROGATE_PATTERN.test(value)) {
    return truncateUtf8CodePointWalk(value, maximumBytes);
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) {
    return { text: value };
  }
  const budget = Math.max(0, maximumBytes - ELLIPSIS_BYTES);
  let end = Math.min(budget, bytes.byteLength);
  while (end > 0 && isUtf8ContinuationByte(bytes[end]!)) {
    end -= 1;
  }
  const prefix = decoder.decode(bytes.subarray(0, end));
  const text = prefix + (maximumBytes >= ELLIPSIS_BYTES ? ELLIPSIS : "");
  return {
    text,
    truncation: {
      truncated: true,
      retainedBytes: utf8Bytes(text),
      reason: "byte_limit",
    },
  };
}

export function boundDisplayText(
  value: unknown,
  limits: PayloadLimits = DEFAULT_PAYLOAD_LIMITS,
): BoundedDisplayText {
  return truncateUtf8(
    typeof value === "string" ? value : "",
    limits.maximumDisplayTextBytes,
  );
}

export function boundText(
  value: unknown,
  maximumBytes = DEFAULT_PAYLOAD_LIMITS.maximumStringBytes,
): BoundedText {
  return truncateUtf8(typeof value === "string" ? value : "", maximumBytes);
}

export function boundTextTail(
  value: unknown,
  maximumBytes = DEFAULT_PAYLOAD_LIMITS.maximumStringBytes,
): BoundedText {
  if (typeof value !== "string") return { text: "" };
  if (maximumBytes <= 0) {
    return {
      text: "",
      truncation: {
        truncated: true,
        retainedBytes: 0,
        reason: "byte_limit",
      },
    };
  }
  // One whole-string encode instead of one encode per retained code
  // point; the cut reproduces the previous backward walk exactly — the
  // maximal code-point suffix whose byte length fits the budget.
  if (LONE_SURROGATE_PATTERN.test(value)) {
    return textTailCodePointWalk(value, maximumBytes);
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return { text: value };
  let start = bytes.byteLength - maximumBytes;
  while (start < bytes.byteLength && isUtf8ContinuationByte(bytes[start]!)) {
    start += 1;
  }
  const text = decoder.decode(bytes.subarray(start));
  return {
    text,
    truncation: {
      truncated: true,
      retainedBytes: bytes.byteLength - start,
      reason: "byte_limit",
    },
  };
}

function normalizedSensitiveKey(key: string): string {
  return key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function sensitiveKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key);
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey")
  );
}

function isBinary(value: unknown): boolean {
  return (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(value))
  );
}

interface BoundContext {
  readonly limits: PayloadLimits;
  readonly seen: WeakSet<object>;
  readonly initialBytes: number;
  remainingBytes: number;
  remainingNodes: number;
  remainingStructuralBytes: number;
}

function consumeText(
  value: string,
  context: BoundContext,
  maximumBytes: number,
): BoundedText {
  const bounded = truncateUtf8(
    value,
    Math.max(0, Math.min(maximumBytes, context.remainingBytes)),
  );
  context.remainingBytes = Math.max(
    0,
    context.remainingBytes - utf8Bytes(bounded.text),
  );
  return bounded;
}

function boundValueAt(
  value: unknown,
  context: BoundContext,
  depth: number,
): BoundedValue {
  if (
    context.remainingNodes <= 0 ||
    context.remainingStructuralBytes < 4
  ) {
    if (Array.isArray(value)) {
      return {
        kind: "array",
        values: [],
        truncation: {
          truncated: true,
          retainedBytes: 0,
          reason: "entry_limit",
        },
      };
    }
    if (typeof value === "object" && value !== null) {
      return {
        kind: "object",
        entries: [],
        truncation: {
          truncated: true,
          retainedBytes: 0,
          reason: "entry_limit",
        },
      };
    }
    return { kind: "omitted", reason: "unsupported" };
  }
  context.remainingNodes -= 1;
  context.remainingStructuralBytes -= 4;
  if (value === null) {
    context.remainingBytes = Math.max(0, context.remainingBytes - 4);
    return null;
  }
  if (typeof value === "boolean") {
    context.remainingBytes = Math.max(0, context.remainingBytes - 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { kind: "omitted", reason: "unsupported" };
    }
    context.remainingBytes = Math.max(
      0,
      context.remainingBytes - String(value).length,
    );
    return value;
  }
  if (typeof value === "string") {
    return consumeText(value, context, context.limits.maximumStringBytes);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return { kind: "omitted", reason: "unsupported" };
  }
  if (isBinary(value)) {
    return { kind: "omitted", reason: "binary" };
  }
  if (typeof value !== "object") {
    return { kind: "omitted", reason: "unsupported" };
  }
  if (context.seen.has(value)) {
    return { kind: "omitted", reason: "cycle" };
  }
  if (depth >= context.limits.maximumDepth) {
    return {
      ...(Array.isArray(value)
        ? { kind: "array" as const, values: [] }
        : { kind: "object" as const, entries: [] }),
      truncation: {
        truncated: true,
        retainedBytes: 0,
        reason: "depth_limit",
      },
    };
  }

  context.seen.add(value);
  {
    if (Array.isArray(value)) {
      const maximum = Math.min(
        value.length,
        context.limits.maximumArrayEntries,
      );
      const values: BoundedValue[] = [];
      for (let index = 0; index < maximum; index += 1) {
        if (
          context.remainingBytes <= 0 ||
          context.remainingNodes <= 0 ||
          context.remainingStructuralBytes <= 0
        ) {
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        values.push(
          descriptor && "value" in descriptor
            ? boundValueAt(descriptor.value, context, depth + 1)
            : { kind: "omitted", reason: "unsupported" },
        );
      }
      const truncated = values.length < value.length;
      return {
        kind: "array",
        values,
        ...(truncated
          ? {
              truncation: {
                truncated: true as const,
                retainedBytes: Math.max(
                  0,
                  context.initialBytes - context.remainingBytes,
                ),
                reason:
                  context.remainingBytes <= 0
                    ? ("byte_limit" as const)
                    : ("entry_limit" as const),
              },
            }
          : {}),
      };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: "omitted", reason: "unsupported" };
    }
    const keys = Object.keys(value);
    const entries: Array<{
      readonly key: BoundedDisplayText;
      readonly value: BoundedValue;
    }> = [];
    const maximum = Math.min(keys.length, context.limits.maximumObjectKeys);
    for (let index = 0; index < maximum; index += 1) {
      if (
        context.remainingBytes <= 0 ||
        context.remainingNodes <= 0 ||
        context.remainingStructuralBytes <= 0
      ) {
        break;
      }
      const key = keys[index]!;
      if (normalizedSensitiveKey(key) === "fulloutputpath") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const boundedKey = consumeText(
        key,
        context,
        context.limits.maximumDisplayTextBytes,
      );
      entries.push({
        key: boundedKey,
        value: sensitiveKey(key)
          ? { kind: "redacted", reason: "sensitive_key" }
          : descriptor && "value" in descriptor
            ? boundValueAt(descriptor.value, context, depth + 1)
            : { kind: "omitted", reason: "unsupported" },
      });
    }
    const truncated = entries.length < keys.length;
    return {
      kind: "object",
      entries,
      ...(truncated
        ? {
            truncation: {
              truncated: true as const,
              retainedBytes: Math.max(
                0,
                context.initialBytes - context.remainingBytes,
              ),
              reason:
                context.remainingBytes <= 0
                  ? ("byte_limit" as const)
                  : ("entry_limit" as const),
            },
          }
        : {}),
    };
  }
}

export function boundValue(
  value: unknown,
  options: {
    readonly limits?: PayloadLimits;
    readonly maximumBytes?: number;
  } = {},
): BoundedValue {
  const limits = options.limits ?? DEFAULT_PAYLOAD_LIMITS;
  const maximumBytes = options.maximumBytes ?? limits.maximumArgumentBytes;
  return boundValueAt(
    value,
    {
      limits,
      initialBytes: maximumBytes,
      remainingBytes: maximumBytes,
      seen: new WeakSet(),
      remainingNodes: limits.maximumNodes,
      remainingStructuralBytes: limits.maximumStructuralBytes,
    },
    0,
  );
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function imageMime(value: unknown): AllowedImageMime | undefined {
  return typeof value === "string" &&
    allowedImageMimes.has(value as AllowedImageMime)
    ? (value as AllowedImageMime)
    : undefined;
}

function decodedBase64Bytes(
  value: string,
): number | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function boundToolResult(
  result: unknown,
  isError: boolean,
  limits: PayloadLimits = DEFAULT_PAYLOAD_LIMITS,
): BoundedToolResult {
  const contentValue =
    typeof result === "object" && result !== null
      ? ownData(result, "content")
      : undefined;
  const details =
    typeof result === "object" && result !== null
      ? ownData(result, "details")
      : undefined;
  const source = Array.isArray(contentValue)
    ? contentValue
    : typeof result === "string"
      ? [{ type: "text", text: result }]
      : [];
  let remainingBytes = limits.maximumResultBytes;
  const content: BoundedToolResult["content"][number][] = [];
  const maximumParts = Math.min(
    source.length,
    limits.maximumArrayEntries,
    PAYLOAD_LIMITS.toolResultParts,
  );
  let omittedNonDataPart = false;
  for (let index = 0; index < maximumParts; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (!descriptor || !("value" in descriptor)) {
      omittedNonDataPart = true;
      continue;
    }
    const part = descriptor.value;
    if (remainingBytes <= 0) {
      break;
    }
    if (typeof part !== "object" || part === null) continue;
    const type = ownData(part, "type");
    if (type === "text") {
      const text = ownData(part, "text");
      if (typeof text !== "string") {
        continue;
      }
      const value = boundText(
        text,
        Math.min(remainingBytes, limits.maximumStringBytes),
      );
      remainingBytes -= utf8Bytes(value.text);
      content.push({ kind: "text", value });
      continue;
    }
    if (type === "image") {
      const mime = imageMime(
        ownData(part, "mimeType") ?? ownData(part, "mime_type"),
      );
      const data = ownData(part, "data");
      const maximumEncodedCharacters =
        Math.ceil(limits.maximumImageBytes / 3) * 4;
      if (
        typeof data === "string" &&
        data.length > maximumEncodedCharacters
      ) {
        content.push({
          kind: "image_omitted",
          ...(mime ? { mimeType: mime } : {}),
          reason: mime ? "byte_limit" : "unsupported_mime",
        });
        continue;
      }
      const decoded =
        typeof data === "string"
          ? decodedBase64Bytes(data)
          : undefined;
      if (!mime) {
        content.push({ kind: "image_omitted", reason: "unsupported_mime" });
      } else if (decoded === undefined) {
        content.push({
          kind: "image_omitted",
          mimeType: mime,
          reason: "invalid_data",
        });
      } else if (
        decoded > limits.maximumImageBytes ||
        utf8Bytes(data as string) > remainingBytes
      ) {
        content.push({
          kind: "image_omitted",
          mimeType: mime,
          reason: "byte_limit",
        });
      } else {
        remainingBytes -= utf8Bytes(data as string);
        content.push({
          kind: "image_inline",
          dataBase64: data as string,
          mimeType: mime,
          decodedBytes: decoded,
        });
      }
    }
  }
  const sourceTruncated =
    omittedNonDataPart ||
    maximumParts < source.length ||
    content.length < maximumParts;
  return {
    content,
    ...(details === undefined
      ? {}
      : {
          details: boundValue(details, {
            limits,
            maximumBytes: Math.max(0, remainingBytes),
          }),
        }),
    isError,
    ...(sourceTruncated
      ? {
          truncation: {
            truncated: true,
            retainedBytes: limits.maximumResultBytes - remainingBytes,
            reason:
              remainingBytes <= 0 ? "byte_limit" : "entry_limit",
          },
        }
      : {}),
  };
}

export function countUnifiedDiff(diff: string): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function assertBoundedSerializedPayload(
  value: unknown,
  maximumBytes = MAXIMUM_BROWSER_ITEM_BYTES,
): void {
  const serialized = JSON.stringify(value);
  if (utf8Bytes(serialized) > maximumBytes) {
    throw new Error("normalized_payload_exceeds_serialized_byte_limit");
  }
}
