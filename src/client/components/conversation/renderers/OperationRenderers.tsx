import type {
  BoundedText,
  CommandItem,
  FileChangeItem,
  FileReadItem,
  McpItem,
  ToolItem,
  WebSearchItem,
} from "../../../../shared/index.js";
import { MoveHorizontal, WrapText } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  getDiffLineWrap,
  setDiffLineWrap,
  subscribeDiffLineWrap,
} from "../../../app/settings.js";
import {
  selectPierreFileChangeCandidate,
  type PierreFileChangeCandidate,
} from "../../../lib/pierre-patch-candidate.js";
import { LegacyDiffContent } from "../../diff/LegacyDiffContent.js";
import { OperationShell } from "../OperationShell";
import {
  BoundedTextBlock,
  StructuredValue,
  TruncationNotice,
} from "../StructuredValue";
import { ToolResult } from "../ToolResult";
import type { ConversationItemRenderer } from "../types";
import { WorkspaceFileOpenButton } from "../../../workspace-files/WorkspaceFileOpenButton.js";
import { fileChangeNavigation } from "../file-operation-navigation.js";

const LazyPierreFileChangeDiff = lazy(async () => {
  const module = await import("../../diff/pierre-file-change-diff.js");
  return { default: module.PierreFileChangeDiff };
});

export const commandRenderer: ConversationItemRenderer<CommandItem> = {
  kind: "command",
  render(item) {
    const command = { ...item.command, text: commandDisplayText(item.command) };
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        target={commandPreview(command)}
        title="Command"
      >
        <section aria-label="Command details">
          <h4>Command</h4>
          <pre>{command.text}</pre>
          <TruncationNotice truncation={item.command.truncation} />
          {item.cwd && (
            <p>
              Working directory: <code>{item.cwd.text}</code>
            </p>
          )}
          {item.timeoutMs !== undefined && (
            <p>Timeout: {formatDuration(item.timeoutMs)}</p>
          )}
          <h4>Output</h4>
          <BoundedTextBlock
            emptyText={
              item.phase === "preflight_or_executing"
                ? "Waiting for output…"
                : "No output."
            }
            value={item.output}
          />
        </section>
      </OperationShell>
    );
  },
};

function commandDisplayText(command: BoundedText): string {
  // Only unwrap a complete, single quoted argument; keep extra shell arguments
  // or operations visible and never mistake a truncated quote for the wrapper.
  if (command.truncation) return command.text;
  const match = /^(?:\/[^\s]+\/)?bash\s+-lc\s+(?:'([^']*)'|"((?:[^"\\]|\\[\s\S])*)")$/u.exec(command.text);
  if (!match) return command.text;
  return match[1] ?? match[2]!.replace(/\\([\$`"\\\n])/gu, (_, character: string) =>
    character === "\n" ? "" : character,
  );
}

function commandPreview(command: BoundedText): string {
  const firstLine = command.text.split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "";
  const characters = Array.from(firstLine);
  const truncated = characters.length > 512 ||
    firstLine.length < command.text.length || command.truncation !== undefined;
  return truncated
    ? `${characters.slice(0, 511).join("")}…`
    : firstLine;
}

export const fileReadRenderer: ConversationItemRenderer<FileReadItem> = {
  kind: "file_read",
  render(item) {
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        target={item.path.text}
        title="Read"
      >
        <section aria-label="File read details">
          <p>
            <code>{item.path.text}</code>
            {item.range && ` · ${formatRangeStat(item.range)}`}
          </p>
          <FilePreviewBlock
            emptyText="No content preview."
            navigation={{
              path: item.path.text,
              lineNumber: item.range?.startLine ?? 1,
            }}
            value={item.contentPreview}
          />
        </section>
      </OperationShell>
    );
  },
};

export const fileChangeRenderer: ConversationItemRenderer<FileChangeItem> = {
  kind: "file_change",
  render(item) {
    const pierreCandidate = selectPierreFileChangeCandidate(item);
    const additions = pierreCandidate?.additions ?? item.additions;
    const deletions = pierreCandidate?.deletions ?? item.deletions;
    const hasCounts = (additions ?? 0) > 0 || (deletions ?? 0) > 0;
    const navigation = fileChangeNavigation(item, pierreCandidate);
    const effectNote =
      item.effect === "proposed" || item.effect === "not_applied"
        ? item.effect.replaceAll("_", " ")
        : undefined;
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        summary={
          hasCounts ? (
            <DiffCounts additions={additions} deletions={deletions} />
          ) : undefined
        }
        target={item.path.text}
        title={capitalize(item.operation)}
      >
        <section aria-label="File change details">
          {(item.destinationPath || effectNote) && (
            <div className="file-row">
              <span className="file-path">
                {item.path.text}
                {item.destinationPath && <> → {item.destinationPath.text}</>}
              </span>
              {effectNote && <span className="file-stats">{effectNote}</span>}
            </div>
          )}
          {pierreCandidate ? (
            <DiffBlock
              destinationPath={item.destinationPath?.text}
              itemId={item.id}
              itemRevision={item.revision}
              itemStatus={item.status}
              navigation={navigation}
              path={item.path.text}
              pierreCandidate={pierreCandidate}
              value={pierreCandidate.value}
            />
          ) : item.diff ? (
            <DiffBlock
              destinationPath={item.destinationPath?.text}
              itemId={item.id}
              itemRevision={item.revision}
              itemStatus={item.status}
              navigation={navigation}
              path={item.path.text}
              value={item.diff.text}
            />
          ) : item.contentPreview ? (
            <FilePreviewBlock
              navigation={navigation}
              value={item.contentPreview}
            />
          ) : null}
        </section>
      </OperationShell>
    );
  },
};

function FilePreviewBlock({
  value,
  navigation,
  emptyText,
}: {
  readonly value?: BoundedText;
  readonly navigation?: { readonly path: string; readonly lineNumber: number };
  readonly emptyText?: string;
}): React.JSX.Element {
  return (
    <div className="file-preview-block">
      <div className="file-block-controls">
        {navigation && (
          <WorkspaceFileOpenButton
            lineNumber={navigation.lineNumber}
            path={navigation.path}
          />
        )}
      </div>
      <BoundedTextBlock emptyText={emptyText} value={value} />
    </div>
  );
}

export const toolRenderer: ConversationItemRenderer<ToolItem> = {
  kind: "tool",
  render(item) {
    const title = item.title.text || item.toolName.text;
    const target =
      item.toolName.text && item.toolName.text !== title
        ? item.toolName.text
        : undefined;
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        target={target}
        title={title}
      >
        <section aria-label="Tool details">
          {item.arguments !== undefined && (
            <>
              <h4>Arguments</h4>
              <StructuredValue value={item.arguments} />
            </>
          )}
          <h4>Result</h4>
          <ToolResult result={item.result} />
        </section>
      </OperationShell>
    );
  },
};

export const mcpRenderer: ConversationItemRenderer<McpItem> = {
  kind: "mcp",
  render(item) {
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        target={item.server.text}
        title={item.toolName.text}
      >
        <section aria-label="MCP details">
          {item.arguments !== undefined && (
            <>
              <h4>Arguments</h4>
              <StructuredValue value={item.arguments} />
            </>
          )}
          <h4>Result</h4>
          <ToolResult result={item.result} />
        </section>
      </OperationShell>
    );
  },
};

export const webSearchRenderer: ConversationItemRenderer<WebSearchItem> = {
  kind: "web_search",
  render(item) {
    return (
      <OperationShell
        error={item.error}
        phase={item.phase}
        target={item.query?.text}
        title="Web search"
      >
        <section aria-label="Web search details">
          {item.query && (
            <p>
              Query: <strong>{item.query.text}</strong>
            </p>
          )}
          <ToolResult result={item.result} />
        </section>
      </OperationShell>
    );
  },
};

function DiffCounts({
  additions,
  deletions,
}: {
  additions?: number;
  deletions?: number;
}): React.JSX.Element {
  return (
    <span className="diff-counts">
      <span className="diff-add">+{additions ?? 0}</span>{" "}
      <span className="diff-del">−{deletions ?? 0}</span>
    </span>
  );
}

function DiffBlock({
  value,
  path,
  destinationPath,
  itemId,
  itemRevision,
  itemStatus,
  navigation,
  pierreCandidate,
}: {
  value: BoundedText;
  path: string;
  destinationPath?: string;
  itemId: string;
  itemRevision: number;
  itemStatus: FileChangeItem["status"];
  navigation?: ReturnType<typeof fileChangeNavigation>;
  pierreCandidate?: PierreFileChangeCandidate;
}): React.JSX.Element {
  const [wrap, setWrap] = useState(getDiffLineWrap);
  useEffect(() => subscribeDiffLineWrap(setWrap), []);
  return (
    <div className="bounded-text diff" data-testid="bounded-text">
      <div className="file-block-controls diff-controls">
        {navigation && (
          <WorkspaceFileOpenButton
            lineNumber={navigation.lineNumber}
            path={navigation.path}
          />
        )}
        <button
          aria-label={
            wrap
              ? "Line wrap on — switch to horizontal scroll"
              : "Horizontal scroll — switch to line wrap"
          }
          aria-pressed={wrap}
          className="diff-wrap-toggle"
          onClick={() => setDiffLineWrap(!wrap)}
          title={
            wrap
              ? "Line wrap on — switch to horizontal scroll"
              : "Horizontal scroll — switch to line wrap"
          }
          type="button"
        >
          {wrap ? <WrapText size={14} /> : <MoveHorizontal size={14} />}
        </button>
      </div>
      {pierreCandidate !== undefined ? (
        <Suspense
          fallback={
            <div className="diff-loading" data-testid="diff-loading">
              Loading diff…
            </div>
          }
        >
          <LazyPierreFileChangeDiff
            destinationPath={destinationPath}
            itemId={itemId}
            itemRevision={itemRevision}
            itemStatus={itemStatus}
            path={path}
            source={pierreCandidate.source}
            wrap={wrap}
          />
        </Suspense>
      ) : (
        <LegacyDiffContent text={value.text} wrap={wrap} />
      )}
      <TruncationNotice truncation={value.truncation} />
    </div>
  );
}

function formatRangeStat(range?: {
  startLine: number;
  endLine: number;
}): string | undefined {
  if (!range) return undefined;
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}–${range.endLine}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  }
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
