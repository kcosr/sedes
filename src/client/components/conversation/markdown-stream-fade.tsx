import { createContext, useContext } from "react";
import type { Components } from "react-markdown";
import { decodeString } from "micromark-util-decode-string";
import {
  MAX_ANIMATED_GRAPHEMES,
  opacityAt,
  segmentGraphemes,
  type AnimatedGrapheme,
  type StreamFadeState,
} from "./smooth-streaming-text.js";

export const MarkdownStreamFadeContext = createContext<{
  readonly records: ReadonlyMap<number, AnimatedGrapheme>;
  readonly nowMs: number;
} | undefined>(undefined);

// A stable component identity lets MarkdownContent stay memoized on opacity
// frames. Native Markdown semantics remain accessible; there is no duplicate
// literal-source label or hidden copy of the rendered text.
export const MarkdownStreamSpan: NonNullable<Components["span"]> = ({
  node,
  children,
  ...props
}) => {
  const frame = useContext(MarkdownStreamFadeContext);
  const index = node?.properties["data-stream-index"];
  const record =
    typeof index === "number" ? frame?.records.get(index) : undefined;
  return (
    <span
      {...props}
      style={record && frame
        ? { display: "inline", opacity: opacityAt(record, frame.nowMs) }
        : props.style}
    >
      {children}
    </span>
  );
};

interface HastNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Decorate only the bounded source tail, after Markdown has chosen structure. */
export function rehypeStreamFade(
  fade: StreamFadeState,
): () => (tree: HastNode) => void {
  const indices = new Map<number, number>();
  let offset = fade.opaquePrefix.length;
  for (const record of fade.animated) {
    for (let unit = 0; unit < record.grapheme.length; unit++) {
      indices.set(offset++, record.index);
    }
  }

  return () => (tree) => {
    let spanCount = 0;
    const visit = (node: HastNode, parent?: HastNode): void => {
      if (!node.children) return;
      const blockCode = parent?.tagName === "pre" && node.tagName === "code";
      if (blockCode) {
        const classes = node.properties?.className;
        if (Array.isArray(classes) && classes.includes("language-mermaid")) return;
        // The parser emits one unpositioned literal child for a code block.
        // Leave any subsequently transformed code structure alone.
        if (node.children.length !== 1 || node.children[0]?.type !== "text") return;
      }
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== "text") {
          visit(child, node);
          return [child];
        }
        const position = blockCode ? node.position : child.position;
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (
          start === undefined || end === undefined ||
          end <= fade.opaquePrefix.length || !child.value ||
          spanCount >= MAX_ANIMATED_GRAPHEMES
        ) return [child];
        const offsets = blockCode ? blockCodeSourceOffsets(
          fade.source.slice(start, end), child.value, start,
        ) : textSourceOffsets(
          fade.source.slice(start, end),
          child.value,
          start,
          node.tagName === "code",
        );
        if (!offsets) return [child];

        const result: HastNode[] = [];
        let textOffset = 0;
        let plain = "";
        const flushPlain = () => {
          if (plain) result.push({ type: "text", value: plain });
          plain = "";
        };
        for (const grapheme of segmentGraphemes(child.value)) {
          const sourceOffset = offsets[textOffset];
          const index = sourceOffset === undefined
            ? undefined : indices.get(sourceOffset);
          textOffset += grapheme.length;
          // Keep whitespace as text nodes: accessible-name computation trims
          // standalone whitespace elements between letters/words.
          if (
            index === undefined || /^\s+$/u.test(grapheme) ||
            spanCount >= MAX_ANIMATED_GRAPHEMES
          ) {
            plain += grapheme;
            continue;
          }
          flushPlain();
          spanCount++;
          result.push({
            type: "element",
            tagName: "span",
            properties: {
              className: ["progressive-markdown-grapheme"],
              "data-stream-index": index,
            },
            children: [{ type: "text", value: grapheme }],
          });
        }
        flushPlain();
        return result;
      });
    };
    visit(tree);
  };
}

/** Code is literal: match each rendered line to its source suffix, removing
 * only container/indentation prefixes. In particular, never decode entities
 * or backslash escapes. The final newline is added by remark-rehype and has
 * no source offset, including when the source itself ends with a newline.
 */
function blockCodeSourceOffsets(
  raw: string,
  value: string,
  start: number,
): (number | undefined)[] | undefined {
  if (!value.endsWith("\n")) return undefined;
  const sourceLines = raw.split(/(\r\n|\r|\n)/u);
  const fence = sourceLines[0]!.match(/^[ ]{0,3}(`{3,}|~{3,})/u)?.[1];
  let lineStart = start;
  if (fence) {
    if (sourceLines.length < 3) return undefined;
    lineStart += sourceLines[0]!.length + sourceLines[1]!.length;
    sourceLines.splice(0, 2);
  }
  const visibleLines = value.slice(0, -1).split(/(\r\n|\r|\n)/u);
  if (visibleLines.length > sourceLines.length) return undefined;
  const offsets: (number | undefined)[] = [];
  for (let line = 0; line < visibleLines.length; line++) {
    const sourceLine = sourceLines[line]!;
    const visibleLine = visibleLines[line]!;
    const prefixLength = sourceLine.length - visibleLine.length;
    if (
      !sourceLine.endsWith(visibleLine) ||
      (line % 2 === 1
        ? sourceLine !== visibleLine
        : !/^[ \t>]*$/u.test(sourceLine.slice(0, prefixLength)))
    ) return undefined;
    for (let unit = 0; unit < visibleLine.length; unit++) {
      offsets.push(lineStart + prefixLength + unit);
    }
    lineStart += sourceLine.length;
  }
  // Anything after the rendered body must be its final line ending and an
  // optional closing fence. Reject unexpected removed or transformed lines.
  const remainder = sourceLines.slice(visibleLines.length);
  if (remainder.length > 2) return undefined;
  if (remainder.length === 2 && remainder[1] !== "") {
    const closing = remainder[1]!.replace(/^[ \t>]*/u, "").trimEnd();
    if (!fence || closing.length < fence.length ||
      !Array.from(closing).every((character) => character === fence[0])) return undefined;
  }
  offsets.push(undefined);
  return offsets;
}

/**
 * Text positions cover Markdown source, not displayed characters. Decode
 * escapes/entities with the parser's decoder and retain their source offsets.
 * Continuation lines may include list indentation or blockquote markers; the
 * rendered line is the suffix after those prefixes. Never guess an offset for
 * an unrecognized transform: its text still renders normally at full opacity.
 */
function textSourceOffsets(
  raw: string,
  value: string,
  start: number,
  inlineCode: boolean,
): number[] | undefined {
  if (inlineCode) {
    const fence = raw.match(/^`+/u)?.[0];
    if (!fence || !raw.endsWith(fence)) return undefined;
    raw = raw.slice(fence.length, -fence.length);
    start += fence.length;
    return inlineCodeSourceOffsets(raw, value, start);
  }

  const tokens = /\\[!-/:-@\[-`{-~]|&(?:#(?:\d{1,7}|[xX][\da-fA-F]{1,6})|[\da-zA-Z]{1,31});/gu;
  let decoded = "";
  const offsets: number[] = [];
  let cursor = 0;
  const appendLiteral = (end: number) => {
    while (cursor < end) {
      offsets.push(start + cursor);
      decoded += raw[cursor++];
    }
  };
  for (const match of raw.matchAll(tokens)) {
    appendLiteral(match.index);
    const replacement = decodeString(match[0]);
    for (let index = 0; index < replacement.length; index++) {
      offsets.push(start + cursor + (replacement === match[0] ? index : 0));
    }
    decoded += replacement;
    cursor += match[0].length;
  }
  appendLiteral(raw.length);

  if (decoded === value) return offsets;
  const sourceLines = decoded.split(/(\r\n|\r|\n)/u);
  const visibleLines = value.split(/(\r\n|\r|\n)/u);
  if (sourceLines.length !== visibleLines.length) return undefined;
  const mapped: number[] = [];
  let lineStart = 0;
  for (let line = 0; line < sourceLines.length; line++) {
    const originalLine = sourceLines[line]!;
    // Markdown removes spaces/tabs before a soft break, in addition to the
    // container prefix on the following line. Keep the original line length
    // when advancing so later characters retain their source positions.
    const visibleLine = visibleLines[line]!;
    const sourceLine = !originalLine.endsWith(visibleLine) &&
      line % 2 === 0 && line + 1 < sourceLines.length
      ? originalLine.replace(/[ \t]+$/u, "") : originalLine;
    if (!sourceLine.endsWith(visibleLine)) return undefined;
    const end = lineStart + sourceLine.length;
    for (let index = end - visibleLine.length; index < end; index++) {
      mapped.push(offsets[index]!);
    }
    lineStart += originalLine.length;
  }
  return mapped;
}

/** Match code line suffixes before normalizing their line endings to spaces.
 * A literal `>` can also occur in code: accept only a unique complete mapping,
 * rather than deciding that every apparent blockquote prefix is syntax.
 */
function inlineCodeSourceOffsets(
  raw: string,
  value: string,
  start: number,
): number[] | undefined {
  const lines = raw.split(/(\r\n|\r|\n)/u);
  const targets = [];
  const trimsOuterSpaces = (text: string) =>
    text.startsWith(" ") && text.endsWith(" ") && /[^ ]/u.test(text);
  if (!trimsOuterSpaces(value)) targets.push({ text: value, trim: false });
  if (/[^ ]/u.test(value)) targets.push({ text: ` ${value} `, trim: true });
  let result: number[] | undefined;
  for (const target of targets) {
    const offsets: number[] = [];
    let sourceOffset = start;
    let valid = true;
    for (let line = 0; line < lines.length; line++) {
      const sourceLine = lines[line]!;
      const separator = line % 2 === 1;
      const prefixLength = line > 0 && !separator
        ? sourceLine.match(/^[ \t>]*/u)![0].length : 0;
      if (prefixLength > MAX_ANIMATED_GRAPHEMES) return undefined;
      let matched: number[] | undefined;
      for (let prefix = 0; prefix <= prefixLength; prefix++) {
        const text = separator ? " " : sourceLine.slice(prefix);
        if (!target.text.startsWith(text, offsets.length)) continue;
        // Multiple matching suffixes are ambiguous even if a later line could
        // disambiguate them. Leave these unusual cases opaque.
        if (matched) { valid = false; break; }
        matched = separator ? [sourceOffset] : Array.from(
          { length: text.length }, (_, index) => sourceOffset + prefix + index,
        );
      }
      if (!valid || !matched) { valid = false; break; }
      for (const offset of matched) offsets.push(offset);
      sourceOffset += sourceLine.length;
    }
    if (!valid || offsets.length !== target.text.length) continue;
    if (result) return undefined;
    result = target.trim ? offsets.slice(1, -1) : offsets;
  }
  return result;
}
