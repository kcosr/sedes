import type { ContextExcerptStagingTarget } from "../context-excerpts/coordinator.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CodeViewItem,
  CodeViewLineSelection,
  FileContents,
  SelectedLineRange,
} from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CreateEditor,
} from "@pierre/diffs/react";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../app/appearance.js";
import { boundedPierreLanguage } from "./pierre-language.js";
import {
  captureFileLineSelection,
  type CapturedFileLineSelection,
  type PierreSelectionCapture,
} from "../context-excerpts/pierre-selection.js";
import {
  PierreSelectionAction,
  type PierreSelectionStageResult,
} from "../context-excerpts/PierreSelectionAction.js";
import type { WorkspaceFileSourceLineSeek } from "./open-intent.js";

let nextViewerCacheNamespace = 1;

export function PierreFileViewer({
  path,
  content,
  revision,
  editing,
  truncated = false,
  seek,
  onSeekHandled,
  onChange,
  onAttachSelection,
  stagingTarget,
}: {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
  readonly editing: boolean;
  readonly truncated?: boolean;
  readonly seek?: WorkspaceFileSourceLineSeek;
  readonly onSeekHandled?: (sequence: number) => void;
  readonly onChange: (content: string) => void;
  readonly stagingTarget?: ContextExcerptStagingTarget;
  readonly onAttachSelection?: (
    selection: CapturedFileLineSelection & { readonly note?: string },
    sendImmediately?: boolean,
  ) => PierreSelectionStageResult;
}): React.JSX.Element {
  const [themeType, setThemeType] = useState(getResolvedAppearance);
  const [cacheNamespace] = useState(
    () => `workspace-file-viewer-${nextViewerCacheNamespace++}`,
  );
  useEffect(() => subscribeResolvedAppearance(setThemeType), []);
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null);
  const [pendingSelection, setPendingSelection] = useState<
    PierreSelectionCapture<CapturedFileLineSelection> | undefined
  >();
  const [copyConfirmation, setCopyConfirmation] = useState<string>();
  const [seekNotice, setSeekNotice] = useState<string>();
  const codeViewRef = useRef<CodeViewHandle<undefined> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const handledSeekSequenceRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const codeView = codeViewRef.current;
    if (
      !seek ||
      !codeView ||
      handledSeekSequenceRef.current === seek.sequence
    ) {
      return;
    }
    handledSeekSequenceRef.current = seek.sequence;
    const lineCount = countLines(content);
    if (seek.lineNumber > lineCount) {
      setSeekNotice(
        truncated
          ? `Line ${seek.lineNumber} is outside this truncated preview.`
          : `Line ${seek.lineNumber} is no longer present in this file.`,
      );
    } else {
      codeView.scrollTo({
        type: "line",
        id: path,
        lineNumber: seek.lineNumber,
        align: "center",
        behavior: "smooth-auto",
      });
      surfaceRef.current?.focus({ preventScroll: true });
      setSeekNotice(`Opened line ${seek.lineNumber}.`);
    }
    onSeekHandled?.(seek.sequence);
  }, [content, onSeekHandled, path, seek, truncated]);

  useEffect(() => {
    if (!seekNotice) return;
    const timeout = globalThis.setTimeout(() => setSeekNotice(undefined), 3_000);
    return () => globalThis.clearTimeout(timeout);
  }, [seekNotice]);

  useEffect(() => {
    setSelectedLines(null);
    setPendingSelection(undefined);
    setCopyConfirmation(undefined);
  }, [content, editing, path, revision]);

  useEffect(() => {
    if (!copyConfirmation) return;
    const timeout = globalThis.setTimeout(
      () => setCopyConfirmation(undefined),
      8_000,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [copyConfirmation]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const emittedContentRef = useRef<string | undefined>(undefined);
  const controlledItemRef = useRef({
    path: "",
    revision: "",
    editing: false,
    content: "",
    version: 0,
  });
  const previousItem = controlledItemRef.current;
  const liveEditEcho =
    editing &&
    previousItem.editing &&
    previousItem.path === path &&
    emittedContentRef.current === content;
  const activeRevisionUpdate =
    editing &&
    previousItem.editing &&
    previousItem.path === path &&
    previousItem.revision !== revision &&
    (previousItem.content === content || liveEditEcho);
  const controlledInputChanged =
    previousItem.version === 0 ||
    previousItem.path !== path ||
    (previousItem.revision !== revision && !activeRevisionUpdate) ||
    previousItem.editing !== editing ||
    (previousItem.content !== content && !liveEditEcho);
  if (controlledInputChanged) {
    controlledItemRef.current = {
      path,
      revision,
      editing,
      content,
      version: previousItem.version + 1,
    };
  } else if (
    previousItem.revision !== revision ||
    previousItem.content !== content
  ) {
    controlledItemRef.current = { ...previousItem, revision, content };
  }
  if (liveEditEcho) emittedContentRef.current = undefined;
  const controlledVersion = controlledItemRef.current.version;
  const handleLineSelected = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || editing || !onAttachSelection) {
        setPendingSelection(undefined);
        return;
      }
      setCopyConfirmation(undefined);
      setPendingSelection(captureFileLineSelection(content, range));
    },
    [content, editing, onAttachSelection],
  );
  const items = useMemo<readonly CodeViewItem[]>(() => {
    const file: FileContents = {
      name: path,
      contents: content,
      lang: boundedPierreLanguage(path),
      cacheKey: `${cacheNamespace}:${path}:${controlledVersion}`,
    };
    return [
      {
        id: path,
        type: "file",
        file,
        edit: editing,
        version: controlledVersion,
      },
    ];
  }, [cacheNamespace, content, controlledVersion, editing, path, revision]);
  const options = useMemo(
    () => ({
      disableFileHeader: true,
      overflow: "scroll" as const,
      themeType,
      stickyHeaders: false,
      enableLineSelection: !editing && onAttachSelection !== undefined,
      onLineSelected: handleLineSelected,
    }),
    [editing, handleLineSelected, onAttachSelection, themeType],
  );

  return (
    <div
      aria-label={`Code view for ${path}`}
      className="pierre-selection-surface"
      ref={surfaceRef}
      tabIndex={-1}
    >
      <EditProvider createEditor={createPierreEditor}>
        <CodeView
          ref={codeViewRef}
          className="workspace-files-code-view"
          items={items}
          options={options}
          editorOptions={PIERRE_EDITOR_OPTIONS}
          selectedLines={selectedLines}
          onSelectedLinesChange={setSelectedLines}
          onItemEditChange={(_item, file) => {
            emittedContentRef.current = file.contents;
            onChangeRef.current(file.contents);
          }}
          style={{ height: "100%", overflow: "auto" }}
        />
      </EditProvider>
      {seekNotice && (
        <div className="workspace-files-seek-notice" role="status">
          {seekNotice}
        </div>
      )}
      {pendingSelection && (
        <PierreSelectionAction
          stagingTarget={stagingTarget}
          copyText={
            pendingSelection.ok ? pendingSelection.value.excerpt : undefined
          }
          key={fileSelectionKey(pendingSelection)}
          label={fileSelectionLabel(pendingSelection)}
          initialError={
            pendingSelection.ok
              ? undefined
              : selectionFailureMessage(pendingSelection.reason)
          }
          onCancel={() => {
            setPendingSelection(undefined);
            setSelectedLines(null);
          }}
          onCopySuccess={() => {
            const copiedSelection = selectedLines;
            setPendingSelection(undefined);
            setCopyConfirmation("Copied selected lines.");
            globalThis.setTimeout(
              () =>
                setSelectedLines((current) =>
                  current === copiedSelection ? null : current,
                ),
              1_200,
            );
          }}
          onStage={(note, sendImmediately) => {
            if (!pendingSelection.ok || !onAttachSelection) return;
            const selection = {
              ...pendingSelection.value,
              ...(note ? { note } : {}),
            };
            const result = sendImmediately
              ? onAttachSelection(selection, true)
              : onAttachSelection(selection);
            if (!result || result.ok) {
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

function countLines(content: string): number {
  let count = 1;
  for (const character of content) {
    if (character === "\n") count += 1;
  }
  return count;
}

function fileSelectionKey(
  selection: PierreSelectionCapture<CapturedFileLineSelection>,
): string {
  if (!selection.ok) return `error:${selection.reason}`;
  return `${selection.value.startLine}:${selection.value.endLine}`;
}

function fileSelectionLabel(
  selection: PierreSelectionCapture<CapturedFileLineSelection>,
): string {
  if (!selection.ok) return "selected lines";
  const { startLine, endLine } = selection.value;
  return startLine === endLine
    ? `selected line ${startLine}`
    : `selected lines ${startLine}–${endLine}`;
}

function selectionFailureMessage(reason: string): string {
  if (reason === "excerpt_too_large") {
    return "The selected lines are too large to attach.";
  }
  return reason === "empty_excerpt"
    ? "Select at least one non-empty line."
    : "That line selection cannot be attached.";
}

const createPierreEditor: CreateEditor<undefined> = (options) =>
  new Editor(options);

const PIERRE_EDITOR_OPTIONS: EditorOptions<undefined> = Object.freeze({
  historyMaxEntries: 200,
});
