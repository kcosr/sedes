#!/usr/bin/env node

/**
 * Final gate for evidence entering a tracked Grok profile.
 *
 * This is intentionally not a raw-transcript safety oracle. Probe callers must
 * first project provider traffic onto an allowlisted structural evidence shape,
 * then write that shape beneath a fresh mode-0700 temporary invocation root as
 * one mode-0600 JSON or NDJSON file. Pass every invocation root, provider home,
 * workspace, host/account identifier, canary, and sensitive value that could
 * occur. Only this module's newly-created canonical output is eligible for
 * tracked evidence. Profile refresh code must sanitize to a new path, compare,
 * and atomically install it; this module never overwrites an existing output.
 * CLI canaries must be synthetic non-credentials; real secrets enter the CLI
 * only through `--secret-env`, never as process arguments.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMITS = Object.freeze({
  maximumInputBytes: 8 * 1024 * 1024,
  maximumOutputBytes: 8 * 1024 * 1024,
  maximumLineBytes: 1024 * 1024,
  maximumLines: 20_000,
  maximumDepth: 32,
  maximumValues: 100_000,
  maximumArrayItems: 20_000,
  maximumObjectProperties: 10_000,
  maximumStringBytes: 512 * 1024,
});

const RAW_FRAME_KEYS = new Set([
  "raw",
  "rawbytes",
  "rawframe",
  "rawframes",
  "rawline",
  "rawpayload",
  "rawwire",
  "unparsedframe",
  "wirebytes",
  "wireframe",
]);

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KNOWN_LOWERCASE_ID_KEYS = new Set([
  "accountid",
  "conversationid",
  "hostid",
  "machineid",
  "promptid",
  "requestid",
  "responseid",
  "sessionid",
  "toolcallid",
  "toolid",
  "turnid",
  "userid",
  "uuid",
]);

export class GrokEvidenceSanitizationError extends Error {
  constructor(code) {
    super(`grok_evidence_${code}`);
    this.name = "GrokEvidenceSanitizationError";
    this.code = code;
  }
}

function fail(code) {
  throw new GrokEvidenceSanitizationError(code);
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail("aborted");
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function normalizedKey(key) {
  return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isSecretKey(key) {
  const compact = normalizedKey(key);
  return /(?:apikeys?|authorization|bearer|cookies?|credentials?|passwords?|privatekeys?|refreshtokens?|secrets?|sessiontokens?|tokens?)$/.test(
    compact,
  );
}

function isProviderMessageKey(key) {
  if (idKindForKey(key)) return false;
  const compact = normalizedKey(key);
  return (
    /(?:cause|detail|diagnostic|error|message|stack|stderr|stdout)$/.test(
      compact,
    ) ||
    ["content", "output", "prompt", "text"].includes(compact) ||
    (compact.startsWith("provider") &&
      ["content", "output", "prompt", "reason", "text"].some((suffix) =>
        compact.endsWith(suffix),
      ))
  );
}

function isTimestampKey(key) {
  const compact = normalizedKey(key);
  return (
    ["at", "date", "datetime", "time", "timestamp"].includes(compact) ||
    /(?:created|updated|started|ended|finished|occurred)at$/.test(compact) ||
    /(?:datetime|timestamp)$/.test(compact)
  );
}

function isDurationKey(key) {
  return /(?:duration|elapsed|latency|timeout)(?:ms|millis|milliseconds)?$/.test(
    normalizedKey(key),
  );
}

function typePreservingPlaceholder(value, label, ordinal) {
  if (typeof value === "number") return -ordinal;
  return `<${label}-${ordinal}>`;
}

function typePreservingConstant(value, stringValue) {
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  if (value === null) return null;
  return stringValue;
}

function idKindForKey(key) {
  const compact = normalizedKey(key);
  const hasIdToken =
    /^id$/i.test(key) ||
    /(?:_|-)id$/i.test(key) ||
    /[a-z0-9](?:Id|ID)$/.test(key) ||
    KNOWN_LOWERCASE_ID_KEYS.has(compact);
  if (!hasIdToken) return undefined;
  if (compact.includes("uuid")) return "uuid";
  if (compact.includes("session") || compact.includes("conversation")) {
    return "session-id";
  }
  if (compact.includes("prompt") || compact.includes("turn")) {
    return "prompt-id";
  }
  if (compact.includes("tool") || compact.includes("call")) return "tool-id";
  if (compact.includes("account") || compact.includes("user")) {
    return "account-id";
  }
  if (compact.includes("host") || compact.includes("machine")) {
    return "host-id";
  }
  if (compact.includes("request") || compact.includes("response")) {
    return "rpc-id";
  }
  return "id";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function buildSecretVariants(secrets) {
  const rawVariants = new Set();
  for (const candidate of secrets) {
    if (typeof candidate !== "string" || byteLength(candidate) < 8) {
      fail("unsafe_secret_seed");
    }
    rawVariants.add(candidate);
    for (const suffixLength of [8, 12, 16]) {
      if (candidate.length > suffixLength) {
        rawVariants.add(candidate.slice(-suffixLength));
      }
    }
  }

  const variants = new Set();
  for (const candidate of rawVariants) {
    const base64 = Buffer.from(candidate, "utf8").toString("base64");
    const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
    const urlEncoded = encodeURIComponent(candidate);
    variants.add(candidate);
    variants.add(base64);
    variants.add(base64Url);
    variants.add(base64Url.replace(/=+$/u, ""));
    variants.add(urlEncoded);
    variants.add(
      urlEncoded.replaceAll(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    );
    variants.add(JSON.stringify(candidate).slice(1, -1));
  }
  return [...variants]
    .filter((value) => value.length >= 8)
    .sort(
      (left, right) =>
        right.length - left.length ||
        (left < right ? -1 : left > right ? 1 : 0),
    );
}

function assertNoSensitiveVariant(value, variants) {
  for (const variant of variants) {
    if (value.includes(variant)) fail("sensitive_output");
  }
}

function isPathEndBoundary(value) {
  return (
    value === undefined || /\s/.test(value) || "\"'`)]},;:?#".includes(value)
  );
}

function replaceConfiguredPathOccurrences(value, configuredPath, state) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    throwIfAborted(state.signal);
    const occurrence = value.indexOf(configuredPath.value, cursor);
    if (occurrence === -1) {
      output += value.slice(cursor);
      break;
    }
    const afterRoot = occurrence + configuredPath.value.length;
    const following = value[afterRoot];
    if (following !== path.sep && !isPathEndBoundary(following)) {
      output += value.slice(cursor, occurrence + 1);
      cursor = occurrence + 1;
      continue;
    }

    output += value.slice(cursor, occurrence);
    let end = afterRoot;
    if (following === path.sep) {
      const quote = occurrence > 0 ? value[occurrence - 1] : undefined;
      if (quote === '"' || quote === "'" || quote === "`") {
        const closing = value.indexOf(quote, afterRoot);
        end = closing === -1 ? value.length : closing;
      } else if (occurrence === 0) {
        end = value.length;
      } else {
        const nextConfiguredPathOccurrence = state.paths.reduce(
          (nearest, { value: candidatePath }) => {
            const candidateOccurrence = value.indexOf(candidatePath, afterRoot);
            if (candidateOccurrence === -1) return nearest;
            return nearest === -1
              ? candidateOccurrence
              : Math.min(nearest, candidateOccurrence);
          },
          -1,
        );
        while (end < value.length) {
          if (end === nextConfiguredPathOccurrence) break;
          const candidate = value[end];
          if (!/\s/.test(candidate) && isPathEndBoundary(candidate)) break;
          end += 1;
        }
      }
    }
    const relative = value.slice(
      following === path.sep ? afterRoot + 1 : afterRoot,
      end,
    );
    output += relative
      ? `${configuredPath.placeholder}/${state.placeholderFor(
          "path",
          relative,
          "string",
        )}`
      : configuredPath.placeholder;
    cursor = end;
  }
  return output;
}

function sanitizeString(value, state) {
  throwIfAborted(state.signal);
  if (byteLength(value) > state.limits.maximumStringBytes) {
    fail("string_too_large");
  }

  let sanitized = value;
  for (const variant of state.secretVariants) {
    sanitized = sanitized.replaceAll(variant, "[REDACTED:secret]");
  }

  for (const configuredPath of state.paths) {
    sanitized = replaceConfiguredPathOccurrences(
      sanitized,
      configuredPath,
      state,
    );
  }

  sanitized = sanitized.replace(UUID_PATTERN, (uuid) =>
    state.placeholderFor("uuid", uuid.toLowerCase(), "string"),
  );

  for (const host of state.hosts) {
    if (sanitized.includes(host)) {
      sanitized = sanitized.replaceAll(
        host,
        state.placeholderFor("host", host, "string"),
      );
    }
  }
  for (const account of state.accounts) {
    if (sanitized.includes(account)) {
      sanitized = sanitized.replaceAll(
        account,
        state.placeholderFor("account", account, "string"),
      );
    }
  }
  return sanitized;
}

function sanitizeValue(value, state, depth, key) {
  state.valueCount += 1;
  if ((state.valueCount & 0xff) === 0) throwIfAborted(state.signal);
  if (state.valueCount > state.limits.maximumValues) fail("too_many_values");
  if (depth > state.limits.maximumDepth) fail("too_deep");

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      fail("invalid_number");
    }
    if (key && isDurationKey(key)) {
      return typePreservingConstant(value, "<duration>");
    }
    if (key && isTimestampKey(key)) {
      return typePreservingConstant(value, "<timestamp>");
    }
    const idKind = key ? idKindForKey(key) : undefined;
    if (idKind) return state.placeholderFor(idKind, value, "number");
    return value;
  }
  if (typeof value === "string") {
    if (key && isSecretKey(key)) return "[REDACTED:secret]";
    const idKind = key ? idKindForKey(key) : undefined;
    if (idKind) return state.placeholderFor(idKind, value, "string");
    if (key && isDurationKey(key)) return "<duration>";
    if (key && isTimestampKey(key)) return "<timestamp>";
    if (ISO_TIMESTAMP_PATTERN.test(value)) return "<timestamp>";
    if (key && isProviderMessageKey(key)) {
      return "[REDACTED:provider-message]";
    }
    return sanitizeString(value, state);
  }
  if (Array.isArray(value)) {
    if (value.length > state.limits.maximumArrayItems) {
      fail("too_many_array_items");
    }
    return value.map((item) => sanitizeValue(item, state, depth + 1));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("invalid_object");
    }
    const keys = Object.keys(value).sort();
    if (
      Object.hasOwn(value, "jsonrpc") &&
      ["error", "id", "method", "result"].some((property) =>
        Object.hasOwn(value, property),
      )
    ) {
      fail("raw_frame");
    }
    if (keys.length > state.limits.maximumObjectProperties) {
      fail("too_many_object_properties");
    }
    const result = Object.create(null);
    for (const property of keys) {
      if (UNSAFE_OBJECT_KEYS.has(property)) fail("unsafe_object_key");
      assertNoSensitiveVariant(property, state.secretVariants);
      if (
        state.objectKeyContainsIdentifier(property) ||
        sanitizeString(property, state) !== property
      ) {
        fail("private_object_key");
      }
      if (RAW_FRAME_KEYS.has(normalizedKey(property))) fail("raw_frame_field");
      if (isSecretKey(property)) {
        result[property] = "[REDACTED:secret]";
        continue;
      }
      if (isProviderMessageKey(property)) {
        result[property] = "[REDACTED:provider-message]";
        continue;
      }
      result[property] = sanitizeValue(
        value[property],
        state,
        depth + 1,
        property,
      );
    }
    return result;
  }
  fail("unsupported_value");
}

function createState(options) {
  throwIfAborted(options.signal);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_limit");
    if (!(key in DEFAULT_LIMITS)) fail("unknown_limit");
  }
  const maps = new Map();
  const identifiers = new Map();
  return {
    signal: options.signal,
    limits,
    valueCount: 0,
    secretVariants: buildSecretVariants([
      ...(options.sensitiveValues ?? []),
      ...(options.secretCanaries ?? []),
    ]),
    paths: [
      ...(options.workspacePaths ?? []).map((value) => ({
        value: path.resolve(value),
        placeholder: "<workspace>",
      })),
      ...(options.homePaths ?? []).map((value) => ({
        value: path.resolve(value),
        placeholder: "<home>",
      })),
    ].sort(
      (left, right) =>
        right.value.length - left.value.length ||
        (left.value < right.value ? -1 : left.value > right.value ? 1 : 0),
    ),
    hosts: [...new Set(options.hosts ?? [])].sort(
      (left, right) =>
        right.length - left.length ||
        (left < right ? -1 : left > right ? 1 : 0),
    ),
    accounts: [...new Set(options.accounts ?? [])].sort(
      (left, right) =>
        right.length - left.length ||
        (left < right ? -1 : left > right ? 1 : 0),
    ),
    objectKeyContainsIdentifier(key) {
      for (const [identity, type] of identifiers) {
        if (
          key === identity ||
          (type === "string" && identity.length >= 8 && key.includes(identity))
        ) {
          return true;
        }
      }
      return false;
    },
    placeholderFor(kind, nativeValue, expectedType) {
      let byValue = maps.get(kind);
      if (!byValue) {
        byValue = new Map();
        maps.set(kind, byValue);
      }
      const identity = `${expectedType}:${String(nativeValue)}`;
      let ordinal = byValue.get(identity);
      if (!ordinal) {
        ordinal = byValue.size + 1;
        byValue.set(identity, ordinal);
      }
      identifiers.set(String(nativeValue), expectedType);
      return typePreservingPlaceholder(nativeValue, kind, ordinal);
    },
  };
}

function seedIdentifierPlaceholders(values, state) {
  const work = [...values]
    .reverse()
    .map((value) => ({ value, depth: 0, key: undefined }));
  let count = 0;
  while (work.length > 0) {
    const current = work.pop();
    count += 1;
    if ((count & 0xff) === 0) throwIfAborted(state.signal);
    if (count > state.limits.maximumValues) fail("too_many_values");
    if (current.depth > state.limits.maximumDepth) fail("too_deep");
    const idKind = current.key ? idKindForKey(current.key) : undefined;
    if (
      idKind &&
      (typeof current.value === "string" ||
        (typeof current.value === "number" &&
          Number.isSafeInteger(current.value)))
    ) {
      state.placeholderFor(idKind, current.value, typeof current.value);
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > state.limits.maximumArrayItems) {
        fail("too_many_array_items");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        work.push({
          value: current.value[index],
          depth: current.depth + 1,
          key: undefined,
        });
      }
    } else if (current.value !== null && typeof current.value === "object") {
      const keys = Object.keys(current.value).sort().reverse();
      if (keys.length > state.limits.maximumObjectProperties) {
        fail("too_many_object_properties");
      }
      for (const key of keys) {
        work.push({
          value: current.value[key],
          depth: current.depth + 1,
          key,
        });
      }
    }
  }
}

export function sanitizeGrokValue(value, options = {}) {
  const state = createState(options);
  seedIdentifierPlaceholders([value], state);
  const sanitized = canonicalize(sanitizeValue(value, state, 0));
  const serialized = JSON.stringify(sanitized);
  assertNoSensitiveVariant(serialized, state.secretVariants);
  if (byteLength(serialized) > state.limits.maximumOutputBytes) {
    fail("output_too_large");
  }
  return sanitized;
}

function parseEvidence(contents, format, limits) {
  if (byteLength(contents) > limits.maximumInputBytes) fail("input_too_large");
  if (contents.includes("\0")) fail("invalid_encoding");
  try {
    if (format === "json") return { values: [JSON.parse(contents)], format };
    const lines = contents.endsWith("\n")
      ? contents.slice(0, -1).split("\n")
      : contents.split("\n");
    if (lines.length > limits.maximumLines) fail("too_many_lines");
    if (lines.length === 0 || lines.some((line) => line.length === 0)) {
      fail("invalid_ndjson");
    }
    return {
      values: lines.map((line) => {
        if (byteLength(line) > limits.maximumLineBytes) fail("line_too_large");
        return JSON.parse(line);
      }),
      format,
    };
  } catch (error) {
    if (error instanceof GrokEvidenceSanitizationError) throw error;
    fail("invalid_json");
  }
}

function serializeEvidence(values, format, state) {
  throwIfAborted(state.signal);
  state.valueCount = 0;
  seedIdentifierPlaceholders(values, state);
  const sanitized = values.map((value) =>
    canonicalize(sanitizeValue(value, state, 0)),
  );
  const output =
    format === "json"
      ? `${JSON.stringify(sanitized[0])}\n`
      : `${sanitized.map((value) => JSON.stringify(value)).join("\n")}\n`;
  if (byteLength(output) > state.limits.maximumOutputBytes) {
    fail("output_too_large");
  }
  assertNoSensitiveVariant(output, state.secretVariants);
  return output;
}

async function assertPrivateRawInput(inputPath, limits, signal) {
  throwIfAborted(signal);
  const resolved = path.resolve(inputPath);
  const inputParent = path.dirname(resolved);
  const [
    rawStats,
    parentStats,
    canonicalInput,
    canonicalParent,
    canonicalTemp,
  ] = await Promise.all([
    lstat(resolved).catch(() => fail("invalid_raw_input")),
    lstat(inputParent).catch(() => fail("invalid_raw_parent")),
    realpath(resolved).catch(() => fail("invalid_raw_input")),
    realpath(inputParent).catch(() => fail("invalid_raw_parent")),
    realpath(os.tmpdir()).catch(() => fail("invalid_temp_root")),
  ]);
  throwIfAborted(signal);
  if (!rawStats.isFile() || rawStats.isSymbolicLink()) {
    fail("invalid_raw_input");
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    fail("invalid_raw_parent");
  }
  if (canonicalInput !== resolved || canonicalParent !== inputParent) {
    fail("noncanonical_raw_path");
  }
  if (
    canonicalInput !== canonicalTemp &&
    !canonicalInput.startsWith(`${canonicalTemp}${path.sep}`)
  ) {
    fail("raw_input_not_temporary");
  }
  if ((rawStats.mode & 0o777) !== 0o600) fail("unsafe_raw_mode");
  if ((parentStats.mode & 0o777) !== 0o700) fail("unsafe_raw_parent_mode");
  if (rawStats.nlink !== 1) fail("unsafe_raw_links");
  if (rawStats.size > limits.maximumInputBytes) fail("input_too_large");
  return Object.freeze({
    path: resolved,
    device: rawStats.dev,
    inode: rawStats.ino,
  });
}

function sameFileIdentity(stats, identity) {
  return stats.dev === identity.device && stats.ino === identity.inode;
}

async function assertPathIdentity(filePath, identity, code, signal) {
  throwIfAborted(signal);
  const current = await lstat(filePath).catch(() => fail(code));
  throwIfAborted(signal);
  if (!current.isFile() || !sameFileIdentity(current, identity)) fail(code);
  return current;
}

async function assertSafeOutput(outputPath, secretVariants, signal) {
  throwIfAborted(signal);
  const resolved = path.resolve(outputPath);
  assertNoSensitiveVariant(path.basename(resolved), secretVariants);
  const parent = path.dirname(resolved);
  const canonicalParent = await realpath(parent).catch(() =>
    fail("invalid_output_parent"),
  );
  throwIfAborted(signal);
  if (canonicalParent !== parent) fail("noncanonical_output_path");
  const parentStats = await stat(parent).catch(() =>
    fail("invalid_output_parent"),
  );
  throwIfAborted(signal);
  if (!parentStats.isDirectory()) fail("invalid_output_parent");
  try {
    await lstat(resolved);
    fail("output_exists");
  } catch (error) {
    if (error instanceof GrokEvidenceSanitizationError) throw error;
    if (error?.code !== "ENOENT") fail("invalid_output");
  }
  return resolved;
}

async function readBoundedUtf8(handle, maximumBytes, signal) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maximumBytes) {
    throwIfAborted(signal);
    const remaining = maximumBytes + 1 - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    throwIfAborted(signal);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maximumBytes) fail("input_too_large");
  const bytes = Buffer.concat(chunks, totalBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_encoding");
  }
}

export async function sanitizeGrokEvidence(options) {
  throwIfAborted(options.signal);
  const state = createState(options);
  const rawInput = await assertPrivateRawInput(
    options.inputPath,
    state.limits,
    options.signal,
  );
  const inputPath = rawInput.path;
  const outputPath = await assertSafeOutput(
    options.outputPath,
    state.secretVariants,
    options.signal,
  );
  if (inputPath === outputPath) fail("same_input_and_output");

  const selectedFormat =
    options.format === "auto" || options.format === undefined
      ? inputPath.endsWith(".ndjson")
        ? "ndjson"
        : "json"
      : options.format;
  if (selectedFormat !== "json" && selectedFormat !== "ndjson") {
    fail("invalid_format");
  }

  const handle = await open(
    inputPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  ).catch(() => fail("invalid_raw_input"));
  let contents;
  let openedIdentity;
  try {
    throwIfAborted(options.signal);
    const openedStats = await handle.stat();
    throwIfAborted(options.signal);
    if (
      !openedStats.isFile() ||
      (openedStats.mode & 0o777) !== 0o600 ||
      openedStats.nlink !== 1 ||
      !sameFileIdentity(openedStats, rawInput) ||
      openedStats.size > state.limits.maximumInputBytes
    ) {
      fail("invalid_raw_input");
    }
    openedIdentity = Object.freeze({
      device: openedStats.dev,
      inode: openedStats.ino,
    });
    contents = await readBoundedUtf8(
      handle,
      state.limits.maximumInputBytes,
      options.signal,
    );
    throwIfAborted(options.signal);
    const { values } = parseEvidence(contents, selectedFormat, state.limits);
    const output = serializeEvidence(values, selectedFormat, state);
    const temporaryOutput = path.join(
      path.dirname(outputPath),
      `.grok-evidence-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    let outputInstalled = false;
    try {
      const outputHandle = await open(
        temporaryOutput,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      let outputIdentity;
      try {
        throwIfAborted(options.signal);
        await outputHandle.writeFile(output, {
          encoding: "utf8",
          signal: options.signal,
        });
        throwIfAborted(options.signal);
        await outputHandle.chmod(0o644);
        throwIfAborted(options.signal);
        await outputHandle.sync();
        throwIfAborted(options.signal);
        const outputStats = await outputHandle.stat();
        outputIdentity = Object.freeze({
          device: outputStats.dev,
          inode: outputStats.ino,
        });
      } finally {
        await outputHandle.close();
      }
      await assertPathIdentity(
        inputPath,
        openedIdentity,
        "raw_identity_changed",
        options.signal,
      );
      throwIfAborted(options.signal);
      await link(temporaryOutput, outputPath).catch((error) => {
        if (error?.code === "EEXIST") fail("output_exists");
        fail("output_install_failed");
      });
      outputInstalled = true;
      await assertPathIdentity(
        outputPath,
        outputIdentity,
        "output_identity_changed",
        options.signal,
      );
      throwIfAborted(options.signal);
      await unlink(temporaryOutput);
      await assertPathIdentity(
        inputPath,
        openedIdentity,
        "raw_identity_changed",
        options.signal,
      );
      // Raw removal is the irreversible commit. Once this check passes, join
      // the short unlink/proof sequence even if the signal fires meanwhile.
      throwIfAborted(options.signal);
      try {
        await unlink(inputPath);
        const unlinkedStats = await handle.stat();
        if (unlinkedStats.nlink !== 0) fail("raw_cleanup_unproved");
      } catch (error) {
        await rm(outputPath, { force: true });
        if (error instanceof GrokEvidenceSanitizationError) throw error;
        fail("raw_cleanup_failed");
      }
    } catch (error) {
      await rm(temporaryOutput, { force: true }).catch(() => undefined);
      if (outputInstalled) {
        await rm(outputPath, { force: true }).catch(() => undefined);
      }
      if (options.signal?.aborted) fail("aborted");
      throw error;
    }

    return Object.freeze({
      format: selectedFormat,
      outputSha256: createHash("sha256").update(output).digest("hex"),
      outputBytes: byteLength(output),
    });
  } finally {
    await handle.close();
  }
}

function usageError() {
  fail("invalid_arguments");
}

function parseArguments(argv) {
  const options = {
    format: "auto",
    workspacePaths: [],
    homePaths: [],
    sensitiveValues: [],
    secretCanaries: [],
    hosts: [],
    accounts: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || value === undefined) usageError();
    index += 1;
    switch (argument) {
      case "--input":
        options.inputPath = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
      case "--format":
        options.format = value;
        break;
      case "--workspace":
        options.workspacePaths.push(value);
        break;
      case "--home":
        options.homePaths.push(value);
        break;
      case "--secret-canary":
        options.secretCanaries.push(value);
        break;
      case "--secret-env": {
        const secret = process.env[value];
        if (!secret) fail("missing_secret_environment");
        options.sensitiveValues.push(secret);
        break;
      }
      case "--host":
        options.hosts.push(value);
        break;
      case "--account":
        options.accounts.push(value);
        break;
      default:
        usageError();
    }
  }
  if (!options.inputPath || !options.outputPath) usageError();
  return options;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const result = await sanitizeGrokEvidence(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("grok_evidence_sanitization_failed\n");
    process.exitCode = 1;
  }
}
