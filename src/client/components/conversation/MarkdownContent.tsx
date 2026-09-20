import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MarkdownStreamFadeContext,
  MarkdownStreamSpan,
} from "./markdown-stream-fade.js";
import { opacityAt } from "./smooth-streaming-text.js";
import { openExternal } from "../../app/router";
import { Check, Copy, ExternalLink, FileText, X } from "lucide-react";
import {
  classifyMarkdownHref,
  type MarkdownFileLinkSource,
  useWorkspaceFileLinkHandler,
} from "../../workspace-files/workspace-file-link-routing.js";
import { getPanelPresentation } from "../../app/settings.js";
import { resolvePanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { rehypeMarkdownSourcePositions } from "./markdown-source-positions.js";
import { MermaidDiagram } from "./MermaidDiagram.js";
import {
  cachedMarkdownHighlight,
  highlightMarkdownCode,
  markdownSyntaxLanguage,
  type MarkdownSyntaxLanguage,
  type MarkdownSyntaxLines,
} from "./markdown-code-highlighting.js";

const SOURCE_POSITION_PLUGINS: NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
> = [rehypeMarkdownSourcePositions];
const NO_REHYPE_PLUGINS: NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
> = [];
type MarkdownComponents = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["components"]
>;
type MarkdownRenderState = {
  readonly source: string;
  readonly streaming: boolean;
  readonly copyCodeBlocks: boolean;
};

const MarkdownRenderContext = createContext<MarkdownRenderState>({
  source: "",
  streaming: false,
  copyCodeBlocks: false,
});

// Keep the pre component identity stable across MarkdownContent renders.
// react-markdown treats a new component function as a new subtree, which
// would otherwise discard interactive Mermaid preview state when an owning
// context updates while the source text itself is unchanged.
const MERMAID_PRE_COMPONENT: NonNullable<MarkdownComponents["pre"]> = ({
  children,
  node,
  ...preProps
}) => {
  const renderState = useContext(MarkdownRenderContext);
  const mermaidSource = fencedMermaidSource(children);
  if (mermaidSource === undefined) {
    return (
      <MarkdownCodeBlock
        copyEnabled={renderState.copyCodeBlocks}
        highlightEnabled={
          !renderState.streaming ||
          fencedCodeNodeIsClosed(renderState.source, node)
        }
        preProps={preProps}
      >
        {children}
      </MarkdownCodeBlock>
    );
  }
  const sourcePositionAttributes = markdownSourcePositionAttributes(preProps);
  return renderState.streaming &&
    !fencedCodeNodeIsClosed(renderState.source, node) ? (
    <div
      {...sourcePositionAttributes}
      aria-label="Mermaid diagram is still streaming"
      className="mermaid-diagram"
      role="group"
    >
      <span className="mermaid-diagram-status" role="status">
        Waiting for diagram…
      </span>
    </div>
  ) : (
    <MermaidDiagram
      source={mermaidSource}
      sourcePositionAttributes={sourcePositionAttributes}
    />
  );
};

const PLAIN_PRE_COMPONENT: NonNullable<MarkdownComponents["pre"]> = ({
  children,
  node,
  ...preProps
}) => {
  const renderState = useContext(MarkdownRenderContext);
  return (
    <MarkdownCodeBlock
      copyEnabled={renderState.copyCodeBlocks}
      highlightEnabled={
        !renderState.streaming ||
        fencedCodeNodeIsClosed(renderState.source, node)
      }
      preProps={preProps}
    >
      {children}
    </MarkdownCodeBlock>
  );
};

// Memoized: react-markdown re-parses the full document on every render, so
// a stable `children` string must not pay that parse again.
export const MarkdownContent = memo(function MarkdownContent({
  children,
  enableMermaid = true,
  streaming = false,
  copyCodeBlocks = false,
  fileLinkSource,
  sourcePositionMetadata = false,
  rehypePlugins = NO_REHYPE_PLUGINS,
}: {
  children: string;
  /** Enables fenced Mermaid recognition. */
  enableMermaid?: boolean;
  /** Replaces an incomplete Mermaid fence with a source-hiding placeholder. */
  streaming?: boolean;
  /** Adds a raw-code copy action to fenced code blocks. */
  copyCodeBlocks?: boolean;
  /** Keeps relative links in a rendered Markdown file's authorized root. */
  fileLinkSource?: MarkdownFileLinkSource;
  /** Adds Markdown source-line hints to rendered blocks for semantic capture. */
  sourcePositionMetadata?: boolean;
  /** Optional document-specific transforms, applied after source metadata. */
  rehypePlugins?: NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;
}): React.JSX.Element {
  const documentPlugins = useMemo(
    () => sourcePositionMetadata
      ? [...SOURCE_POSITION_PLUGINS, ...rehypePlugins]
      : rehypePlugins,
    [sourcePositionMetadata, rehypePlugins],
  );
  const workspaceFileLinks = useWorkspaceFileLinkHandler();
  const [fileLinkNotice, setFileLinkNotice] = useState<string>();
  const renderState = useMemo(
    () => ({ source: children, streaming, copyCodeBlocks }),
    [children, copyCodeBlocks, streaming],
  );
  const mounted = useRef(true);
  useEffect(() => {
    // React development StrictMode replays effect setup and cleanup without
    // remounting the component instance, so restore the live marker on every
    // setup rather than relying only on the ref initializer.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className="markdown">
      <MarkdownRenderContext.Provider value={renderState}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={documentPlugins}
          skipHtml
          urlTransform={(url, key) =>
            key === "href" &&
            classifyMarkdownHref(url, fileLinkSource).kind === "workspace_file"
              ? url
              : defaultUrlTransform(url)
          }
          components={{
            span: MarkdownStreamSpan,
            pre: enableMermaid ? MERMAID_PRE_COMPONENT : PLAIN_PRE_COMPONENT,
            a({ href, children: linkChildren }) {
              const classification = href
                ? classifyMarkdownHref(href, fileLinkSource)
                : { kind: "ordinary" as const };
              if (classification.kind === "invalid_file") {
                return <span>{linkChildren}</span>;
              }
              if (classification.kind === "workspace_file") {
                const fallbackOnUnresolved =
                  !classification.explicit &&
                  classification.request.reference.kind ===
                    "workspace_relative";
                const fallbackWithoutResolver =
                  !classification.explicit &&
                  classification.request.reference.kind !== "root_relative";
                const fallbackHref =
                  (workspaceFileLinks
                    ? fallbackOnUnresolved
                    : fallbackWithoutResolver) && href
                    ? safeUrl(href)
                    : undefined;
                if (!workspaceFileLinks) {
                  if (!fallbackHref) return <span>{linkChildren}</span>;
                  return (
                    <a
                      href={fallbackHref}
                      onClick={(event) => {
                        event.preventDefault();
                        openExternal(fallbackHref);
                      }}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {linkChildren}
                      <ExternalLink size={12} strokeWidth={1.8} />
                    </a>
                  );
                }
                return (
                  <a
                    href={fallbackHref ?? "#"}
                    onClick={(event) => {
                      event.preventDefault();
                      const presentation = resolvePanelPresentation(
                        getPanelPresentation(),
                        event.shiftKey,
                      );
                      setFileLinkNotice(undefined);
                      void Promise.resolve(
                        workspaceFileLinks.openReference(
                          {
                            ...classification.request,
                            presentation,
                          },
                        ),
                      )
                        .then((opened) => {
                          if (
                            opened === false &&
                            fallbackOnUnresolved &&
                            fallbackHref
                          ) {
                            openExternal(fallbackHref);
                          } else if (
                            mounted.current &&
                            opened === false &&
                            !fallbackOnUnresolved
                          ) {
                            setFileLinkNotice(
                              "That file is not available in this workspace.",
                            );
                          }
                        })
                        .catch(() => {
                          if (mounted.current) {
                            setFileLinkNotice(
                              "Could not check that file. Check your connection and try again.",
                            );
                          }
                        });
                    }}
                  >
                    {linkChildren}
                    <FileText size={12} strokeWidth={1.8} />
                  </a>
                );
              }
              const safe = href && safeUrl(href);
              if (!safe) return <span>{linkChildren}</span>;
              return (
                <a
                  href={safe}
                  onClick={(event) => {
                    event.preventDefault();
                    openExternal(safe);
                  }}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {linkChildren}
                  <ExternalLink size={12} strokeWidth={1.8} />
                </a>
              );
            },
            img({ alt }) {
              const description = alt?.trim();
              return (
                <span className="markdown-image-omitted" role="note">
                  Image omitted
                  {description ? ` · ${description}` : ""}
                </span>
              );
            },
          }}
        >
          {children}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
      {fileLinkNotice && (
        <p className="markdown-file-link-notice" role="status">
          {fileLinkNotice}
        </p>
      )}
    </div>
  );
});

function MarkdownCodeBlock({
  children,
  copyEnabled,
  highlightEnabled,
  preProps,
}: {
  readonly children: ReactNode;
  readonly copyEnabled: boolean;
  readonly highlightEnabled: boolean;
  readonly preProps: HTMLAttributes<HTMLPreElement>;
}): React.JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const codeBlock = useMemo(() => fencedCodeBlock(children), [children]);
  const copyText = codeBlock?.source.replace(/\n$/u, "");
  const language = markdownSyntaxLanguage(codeBlock?.className);
  const renderedCode =
    highlightEnabled && codeBlock && language ? (
      codeBlock.animatedIndices.length > 0 ? (
        <SettledHighlightedCode codeBlock={codeBlock} language={language}>
          {children}
        </SettledHighlightedCode>
      ) : (
        <HighlightedMarkdownCode
          className={codeBlock.className}
          language={language}
          source={codeBlock.source}
        />
      )
    ) : (
      children
    );

  useEffect(() => {
    if (copyState === "idle") return undefined;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_800);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  if (!copyEnabled || copyText === undefined) {
    return <pre {...preProps}>{renderedCode}</pre>;
  }

  const copyLabel =
    copyState === "copied"
      ? "Code copied"
      : copyState === "failed"
        ? "Copy failed"
        : "Copy code";
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="markdown-code-block" data-copy-state={copyState}>
      <pre {...preProps}>{renderedCode}</pre>
      <button
        aria-label={copyLabel}
        className="markdown-code-copy"
        onClick={() => void copyCode()}
        title={copyLabel}
        type="button"
      >
        {copyState === "copied" ? (
          <Check aria-hidden="true" size={15} strokeWidth={1.8} />
        ) : copyState === "failed" ? (
          <X aria-hidden="true" size={15} strokeWidth={1.8} />
        ) : (
          <Copy aria-hidden="true" size={15} strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
}

// A closing fence must not replace text that is still fading with opaque
// highlighted tokens. Only blocks with animated text subscribe to fade frames.
function SettledHighlightedCode({ codeBlock, language, children }: {
  readonly codeBlock: MarkdownCodeSource;
  readonly language: MarkdownSyntaxLanguage;
  readonly children: ReactNode;
}): React.JSX.Element {
  const frame = useContext(MarkdownStreamFadeContext);
  const fading = frame && codeBlock.animatedIndices.some((index) => {
    const record = frame.records.get(index);
    return record !== undefined && opacityAt(record, frame.nowMs) < 1;
  });
  return fading ? <>{children}</> : (
    <HighlightedMarkdownCode
      className={codeBlock.className}
      language={language}
      source={codeBlock.source}
    />
  );
}

function HighlightedMarkdownCode({
  className,
  language,
  source,
}: {
  readonly className?: string;
  readonly language: MarkdownSyntaxLanguage;
  readonly source: string;
}): React.JSX.Element {
  const cachedLines = cachedMarkdownHighlight(source, language);
  const [highlighted, setHighlighted] = useState<{
    readonly language: MarkdownSyntaxLanguage;
    readonly lines: MarkdownSyntaxLines;
    readonly source: string;
  } | undefined>(() =>
    cachedLines ? { language, lines: cachedLines, source } : undefined,
  );

  useEffect(() => {
    let current = true;
    void highlightMarkdownCode(source, language)
      .then((lines) => {
        if (current && !cachedLines && lines) {
          setHighlighted({ language, lines, source });
        }
      })
      .catch(() => {
        // A missing or invalid grammar must never hide agent output.
      });
    return () => {
      current = false;
    };
  }, [cachedLines, language, source]);

  const lines =
    cachedLines ??
    (highlighted?.language === language && highlighted.source === source
      ? highlighted.lines
      : undefined);
  return (
    <code
      className={className}
      data-syntax-language={lines ? language : undefined}
    >
      {lines
        ? lines.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 && "\n"}
              {line.map((token, tokenIndex) => (
                <span
                  className="markdown-syntax-token"
                  key={`${lineIndex}:${tokenIndex}`}
                  style={token.style}
                >
                  {token.content}
                </span>
              ))}
            </Fragment>
          ))
        : source}
    </code>
  );
}

type MarkdownCodeSource = {
  readonly className?: string;
  readonly source: string;
  readonly animatedIndices: readonly number[];
};

function fencedCodeBlock(children: ReactNode): MarkdownCodeSource | undefined {
  if (Children.count(children) !== 1) return undefined;
  const child = Children.toArray(children)[0];
  if (
    !isValidElement<{
      readonly children?: ReactNode;
      readonly className?: string;
    }>(child)
  ) {
    return undefined;
  }
  const content = Children.toArray(child.props.children);
  let source = "";
  const animatedIndices: number[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      source += part;
      continue;
    }
    // The fade transform inserts only this known text-only component. Keep
    // copying based on literal code, without accepting arbitrary React content.
    if (
      !isValidElement<{
        children?: ReactNode;
        node?: { properties?: Record<string, unknown> };
      }>(part) || part.type !== MarkdownStreamSpan ||
      typeof part.props.children !== "string"
    ) return undefined;
    const index = part.props.node?.properties?.["data-stream-index"];
    if (typeof index !== "number") return undefined;
    source += part.props.children;
    animatedIndices.push(index);
  }
  return { className: child.props.className, source, animatedIndices };
}

function fencedMermaidSource(children: ReactNode): string | undefined {
  const codeBlock = fencedCodeBlock(children);
  return codeBlock?.className?.split(/\s+/).includes("language-mermaid")
    ? codeBlock.source
    : undefined;
}

function markdownSourcePositionAttributes(
  props: Record<string, unknown>,
): HTMLAttributes<HTMLDivElement> {
  return Object.fromEntries(
    Object.entries(props).filter(([name]) => name.startsWith("data-markdown-")),
  ) as HTMLAttributes<HTMLDivElement>;
}

function fencedCodeNodeIsClosed(source: string, node: unknown): boolean {
  const position = positionedNodeOffsets(node);
  if (!position) return false;
  const block = source.slice(position.start, position.end);
  const lines = block.split(/\r?\n/u);
  const openingLine = blockQuoteLine(lines[0] ?? "");
  const openingLineStart = source.lastIndexOf("\n", position.start - 1) + 1;
  const enclosingQuoteDepth = Math.max(
    openingLine.depth,
    blockQuoteLine(source.slice(openingLineStart, position.start)).depth,
  );
  const opening = openingLine.content.match(/^ {0,3}(`{3,}|~{3,})/u);
  if (!opening) return false;
  const marker = opening[1]!;
  const markerCharacter = marker[0]!;
  let lastLineIndex = lines.length - 1;
  while (lastLineIndex > 0 && lines[lastLineIndex] === "") {
    lastLineIndex -= 1;
  }
  const finalLine = stripBlockQuoteDepth(
    lines[lastLineIndex] ?? "",
    enclosingQuoteDepth,
  );
  if (finalLine === undefined) return false;
  const closingFence = new RegExp(
    `^ {0,3}${markerCharacter}{${marker.length},}[ \\t]*$`,
    "u",
  );
  return closingFence.test(finalLine);
}

function positionedNodeOffsets(
  node: unknown,
): { readonly start: number; readonly end: number } | undefined {
  if (typeof node !== "object" || node === null || !("position" in node)) {
    return undefined;
  }
  const position = node.position;
  if (
    typeof position !== "object" ||
    position === null ||
    !("start" in position) ||
    !("end" in position) ||
    typeof position.start !== "object" ||
    position.start === null ||
    !("offset" in position.start) ||
    typeof position.start.offset !== "number" ||
    typeof position.end !== "object" ||
    position.end === null ||
    !("offset" in position.end) ||
    typeof position.end.offset !== "number"
  ) {
    return undefined;
  }
  return { start: position.start.offset, end: position.end.offset };
}

function blockQuoteLine(line: string): {
  readonly content: string;
  readonly depth: number;
} {
  let remaining = line;
  let depth = 0;
  while (/^ {0,3}>/u.test(remaining)) {
    remaining = remaining.replace(/^ {0,3}>[ \t]?/u, "");
    depth += 1;
  }
  return { content: remaining, depth };
}

function stripBlockQuoteDepth(
  line: string,
  expectedDepth: number,
): string | undefined {
  let remaining = line;
  for (let depth = 0; depth < expectedDepth; depth += 1) {
    if (!/^ {0,3}>/u.test(remaining)) return undefined;
    remaining = remaining.replace(/^ {0,3}>[ \t]?/u, "");
  }
  return remaining;
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
