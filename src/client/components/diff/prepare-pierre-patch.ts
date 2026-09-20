import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { isSafeWholeFilePatchPath } from "../../lib/pierre-patch-candidate.js";
import { boundedPierreLanguage } from "../../workspace-files/pierre-language.js";

export type PreparePierrePatchResult =
  | {
      readonly ok: true;
      readonly fileDiff: FileDiffMetadata;
      readonly emptyFile: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export type PreparePierrePatchInput =
  | {
      readonly kind: "unified_patch";
      readonly text: string;
      readonly path: string;
      readonly destinationPath?: string;
    }
  | {
      readonly kind: "whole_file_write";
      readonly content: string;
      readonly path: string;
    };

export interface SynthesizedWholeFilePatch {
  readonly patch: string;
  readonly additionCount: number;
  readonly emptyFile: boolean;
}

/**
 * Parse a bounded chat patch into Pierre `FileDiffMetadata`, synthesizing
 * file headers from the known path when the payload is hunk-only.
 *
 * Lives in the lazy Pierre chunk graph — do not import from the static
 * conversation registry path.
 */
export function preparePierrePatch(
  input: PreparePierrePatchInput,
): PreparePierrePatchResult {
  if (input.kind === "whole_file_write") {
    const synthesized = synthesizeWholeFileWritePatch(
      input.content,
      input.path,
    );
    if (synthesized === undefined) {
      return { ok: false, reason: "unsafe_path" };
    }
    return acceptParsed(synthesized.patch, input.path, undefined, {
      allowEmpty: synthesized.emptyFile,
      forceNewFile: true,
      strict: true,
    });
  }

  const direct = acceptParsed(input.text, input.path, input.destinationPath);
  if (direct.ok) return direct;

  const synthesized = synthesizeFileHeaders(
    input.text,
    input.path,
    input.destinationPath,
  );
  if (synthesized === undefined) return direct;

  return acceptParsed(synthesized, input.path, input.destinationPath);
}

export function synthesizeWholeFileWritePatch(
  content: string,
  path: string,
): SynthesizedWholeFilePatch | undefined {
  if (!isSafeWholeFilePatchPath(path)) return undefined;

  const lines = splitWholeFileContent(content);
  const additionCount = lines.length;
  let patch = [
    "--- /dev/null",
    `+++ ${path}`,
    `@@ -0,0 +1,${additionCount} @@`,
    "",
  ].join("\n");
  patch += lines.map((line) => `+${line}`).join("");
  if (additionCount > 0 && !content.endsWith("\n")) {
    patch += "\n\\ No newline at end of file\n";
  }
  return { patch, additionCount, emptyFile: additionCount === 0 };
}

export function synthesizeFileHeaders(
  text: string,
  path: string,
  destinationPath?: string,
): string | undefined {
  if (!isSafePatchPath(path)) return undefined;
  if (destinationPath !== undefined && !isSafePatchPath(destinationPath)) {
    return undefined;
  }
  if (!/^@@ /m.test(text)) return undefined;
  if (hasFileHeader(text)) return undefined;
  const body = text.replace(/^\n+/, "");
  return `--- ${path}\n+++ ${destinationPath ?? path}\n${body}`;
}

function acceptParsed(
  text: string,
  path: string,
  destinationPath?: string,
  options: {
    readonly allowEmpty?: boolean;
    readonly forceNewFile?: boolean;
    readonly strict?: boolean;
  } = {},
): PreparePierrePatchResult {
  let parsed;
  try {
    parsed = parsePatchFiles(text, undefined, options.strict);
  } catch {
    return { ok: false, reason: "parse_threw" };
  }

  if (parsed.length !== 1) {
    return { ok: false, reason: "patch_count" };
  }
  const files = parsed[0]?.files ?? [];
  if (files.length !== 1) {
    return { ok: false, reason: "file_count" };
  }
  const file = files[0]!;
  if (file.hunks.length === 0) {
    return { ok: false, reason: "no_hunks" };
  }
  const emptyFile = file.additionLines.length + file.deletionLines.length === 0;
  if (emptyFile && !options.allowEmpty) {
    return { ok: false, reason: "no_lines" };
  }

  const langPath = destinationPath ?? path;
  return {
    ok: true,
    emptyFile,
    fileDiff: {
      ...file,
      // Prefer the known item path for language + stable identity when the
      // patch headers used a/b prefixes or /dev/null.
      name: options.forceNewFile ? langPath : file.name || langPath,
      ...(options.forceNewFile ? { type: "new" as const } : {}),
      lang: boundedPierreLanguage(langPath),
    },
  };
}

function splitWholeFileContent(content: string): string[] {
  if (content.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) break;
    lines.push(content.slice(start, newline + 1));
    start = newline + 1;
  }
  if (start < content.length) lines.push(content.slice(start));
  return lines;
}

function hasFileHeader(text: string): boolean {
  return /^(diff --git|--- |[+]{3} )/m.test(text);
}

function isSafePatchPath(path: string): boolean {
  // Reject empty paths and any ASCII control characters so synthesized
  // ---/+++ headers cannot smuggle extra patch lines or break parsing.
  return path.length > 0 && !/[\0-\x1f\x7f]/.test(path);
}
