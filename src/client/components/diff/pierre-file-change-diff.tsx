import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import {
  contextExcerptSchema,
  type ConversationItem,
} from "../../../shared/index.js";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../../app/appearance.js";
import { LegacyDiffContent } from "./LegacyDiffContent.js";
import { preparePierrePatch } from "./prepare-pierre-patch.js";
import {
  useContextExcerptStaging,
  useContextExcerptStagingSnapshot,
} from "../../context-excerpts/coordinator.js";
import {
  captureUnifiedDiffLineSelection,
  type CapturedDiffLineSelection,
  type PierreSelectionCapture,
} from "../../context-excerpts/pierre-selection.js";
import { PierreSelectionAction } from "../../context-excerpts/PierreSelectionAction.js";
import type { PierreFileChangeSource } from "../../lib/pierre-patch-candidate.js";
import { boundedPierreLanguage } from "../../workspace-files/pierre-language.js";

/**
 * Lazy-chunk entry for chat `file_change` diffs. Imports `@pierre/diffs` so
 * this module must only be loaded via `React.lazy` / dynamic import.
 */
export function PierreFileChangeDiff({
  source,
  path,
  destinationPath,
  itemId,
  itemRevision,
  itemStatus,
  wrap = true,
}: {
  readonly source: PierreFileChangeSource;
  readonly path: string;
  readonly destinationPath?: string;
  readonly itemId: string;
  readonly itemRevision: number;
  readonly itemStatus: ConversationItem["status"];
  readonly wrap?: boolean;
}): React.JSX.Element {
  const [themeType, setThemeType] = useState(getResolvedAppearance);
  const staging = useContextExcerptStaging();
  const stagingStatus = useContextExcerptStagingSnapshot();
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(
    null,
  );
  const [pendingSelection, setPendingSelection] = useState<
    PierreSelectionCapture<CapturedDiffLineSelection> | undefined
  >();
  const [copyConfirmation, setCopyConfirmation] = useState<string>();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sourceText =
    source.kind === "whole_file_write"
      ? source.content
      : source.kind === "unified_patch"
        ? source.text
        : undefined;
  const replacementOldContent =
    source.kind === "replacement_preview" ? source.oldContent : undefined;
  const replacementNewContent =
    source.kind === "replacement_preview" ? source.newContent : undefined;
  useEffect(() => subscribeResolvedAppearance(setThemeType), []);

  const prepared = useMemo(() => {
    if (source.kind === "replacement_preview") return undefined;
    return source.kind === "whole_file_write"
      ? preparePierrePatch({
          kind: "whole_file_write",
          content: source.content,
          path,
        })
      : preparePierrePatch({
          kind: "unified_patch",
          text: source.text,
          path,
          destinationPath,
        });
  }, [destinationPath, path, source.kind, sourceText]);
  const selectionEnabled =
    source.kind !== "replacement_preview" &&
    itemStatus !== "streaming" &&
    staging !== undefined &&
    stagingStatus.available;

  useEffect(() => {
    setSelectedLines(null);
    setPendingSelection(undefined);
    setCopyConfirmation(undefined);
  }, [
    itemId,
    itemRevision,
    itemStatus,
    replacementNewContent,
    replacementOldContent,
    source.kind,
    sourceText,
  ]);

  useEffect(() => {
    if (!copyConfirmation) return;
    const timeout = globalThis.setTimeout(
      () => setCopyConfirmation(undefined),
      8_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [copyConfirmation]);

  const handleLineSelected = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !selectionEnabled || !prepared?.ok) {
        setPendingSelection(undefined);
        return;
      }
      setCopyConfirmation(undefined);
      setPendingSelection(
        captureUnifiedDiffLineSelection(prepared.fileDiff, range),
      );
    },
    [prepared, selectionEnabled],
  );

  const options = useMemo(
    () => ({
      themeType,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      disableLineNumbers: source.kind === "replacement_preview",
      diffStyle: "unified" as const,
      // Quiet between-hunk rules only — drop leading/trailing
      // "N unmodified lines" chrome that line numbers already imply.
      hunkSeparators: "simple" as const,
      enableLineSelection: selectionEnabled,
      ...(selectionEnabled
        ? {
            onLineSelectionChange: setSelectedLines,
            onLineSelected: handleLineSelected,
          }
        : {}),
    }),
    [handleLineSelected, selectionEnabled, source.kind, themeType, wrap],
  );

  if (source.kind !== "replacement_preview" && !prepared?.ok) {
    return <LegacyDiffContent text={sourceText ?? ""} wrap={wrap} />;
  }

  const diffContent =
    source.kind === "replacement_preview" ? (
      <MultiFileDiff
        key={`${itemId}:${itemRevision}:${itemStatus}`}
        newFile={{
          name: destinationPath ?? path,
          contents: source.newContent,
          lang: boundedPierreLanguage(destinationPath ?? path),
        }}
        oldFile={{
          name: path,
          contents: source.oldContent,
          lang: boundedPierreLanguage(path),
        }}
        options={options}
        style={{ width: "100%" }}
      />
    ) : prepared?.ok && prepared.emptyFile ? (
      <div className="diff-empty-file" data-testid="diff-empty-file">
        Empty file.
      </div>
    ) : prepared?.ok ? (
      <FileDiff
        fileDiff={prepared.fileDiff}
        key={`${itemId}:${itemRevision}:${itemStatus}`}
        options={options}
        selectedLines={selectedLines}
        style={{ width: "100%" }}
      />
    ) : null;

  return (
    <div
      aria-label={`Diff for ${destinationPath ?? path}`}
      className="chat-pierre-diff pierre-selection-surface"
      data-testid="pierre-file-change-diff"
      ref={surfaceRef}
      tabIndex={-1}
    >
      {diffContent}
      {pendingSelection && (
        <PierreSelectionAction
          copyText={
            pendingSelection.ok ? pendingSelection.value.excerpt : undefined
          }
          key={diffSelectionKey(pendingSelection)}
          label={diffSelectionLabel(pendingSelection)}
          initialError={
            pendingSelection.ok
              ? undefined
              : diffSelectionFailureMessage(pendingSelection.reason)
          }
          onCancel={() => {
            setPendingSelection(undefined);
            setSelectedLines(null);
          }}
          onCopySuccess={() => {
            const copiedSelection = selectedLines;
            setPendingSelection(undefined);
            setCopyConfirmation("Copied selected diff lines.");
            globalThis.setTimeout(
              () =>
                setSelectedLines((current) =>
                  current === copiedSelection ? null : current,
                ),
              1_200,
            );
          }}
          onStage={(note, sendImmediately) => {
            if (!pendingSelection.ok || !staging) return;
            const candidate = contextExcerptSchema.safeParse({
              id: crypto.randomUUID(),
              excerpt: pendingSelection.value.excerpt,
              ...(note ? { note } : {}),
              source: {
                kind: "conversation_diff",
                itemId,
                itemRevision,
                path,
                ...(destinationPath ? { destinationPath } : {}),
              },
              locator: {
                kind: "diff_line_range",
                start: pendingSelection.value.start,
                end: pendingSelection.value.end,
              },
            });
            if (!candidate.success) {
              return {
                ok: false,
                reason:
                  candidate.error.issues[0]?.message ??
                  "That diff selection cannot be attached.",
              };
            }
            const result = sendImmediately
              ? staging.attachAndSubmit(candidate.data)
              : staging.stage(candidate.data);
            if (result.ok) {
              setPendingSelection(undefined);
              setSelectedLines(null);
              surfaceRef.current?.focus({ preventScroll: true });
            }
            return result;
          }}
          owner={surfaceRef.current}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copyConfirmation ?? ""}
      </span>
      {copyConfirmation && (
        <div className="context-selection-confirmation">
          <span aria-hidden="true">{copyConfirmation}</span>
        </div>
      )}
    </div>
  );
}

function diffSelectionLabel(
  selection: PierreSelectionCapture<CapturedDiffLineSelection>,
): string {
  if (!selection.ok) return "selected diff lines";
  const { start, end } = selection.value;
  return `selected ${start.side} ${start.line} → ${end.side} ${end.line}`;
}

function diffSelectionKey(
  selection: PierreSelectionCapture<CapturedDiffLineSelection>,
): string {
  if (!selection.ok) return `error:${selection.reason}`;
  const { start, end } = selection.value;
  return `${start.side}:${start.line}:${end.side}:${end.line}`;
}

function diffSelectionFailureMessage(reason: string): string {
  if (reason === "cross_hunk_range") {
    return "Select lines within one diff hunk.";
  }
  if (reason === "empty_excerpt") return "Select at least one non-empty line.";
  if (reason === "excerpt_too_large") {
    return "The selected diff lines are too large to attach.";
  }
  return "That diff selection cannot be attached.";
}
