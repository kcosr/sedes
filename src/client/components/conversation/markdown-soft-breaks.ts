import type { Break, Parent, Root, Text } from "mdast";
import type { Point, Position } from "unist";

const LINE_ENDING = /\r\n|\r|\n/u;

/**
 * Render a soft line break (a single newline inside a paragraph, heading text,
 * list item or table cell) as a hard line break, so text reads as it was typed.
 * Blank lines still separate paragraphs, and code is untouched: only `text`
 * nodes are split. Each soft break is exactly one source line ending, so the
 * Nth fragment comes from the Nth source line of the text node, where it ends
 * the line (after any `> ` or indentation prefix, before trailing spaces).
 * A fragment that differs from its source (entities, escapes) keeps that
 * source line's position, which source mapping aligns by diffing; it never
 * borrows a position from another line.
 */
export function remarkSoftBreaks(): (tree: Root, file: { value?: unknown }) => void {
  return (tree, file) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const lines = lineStarts(source);
    splitIn(tree, source, lines);
  };
}

function splitIn(parent: Parent, source: string, lines: readonly number[]): void {
  const children: Parent["children"] = [];
  for (const child of parent.children) {
    if (child.type === "text" && LINE_ENDING.test(child.value)) children.push(...split(child, source, lines));
    else {
      if ("children" in child) splitIn(child as Parent, source, lines);
      children.push(child);
    }
  }
  parent.children = children;
}

function split(node: Text, source: string, lines: readonly number[]): (Text | Break)[] {
  const fragments = node.value.split(LINE_ENDING);
  const located = locate(fragments, node, source, lines);
  const result: (Text | Break)[] = [];
  fragments.forEach((fragment, index) => {
    const position = located?.[index]?.text ?? node.position;
    if (fragment) result.push({ type: "text", value: fragment, ...(position ? { position } : {}) });
    if (index === fragments.length - 1) return;
    const before = located?.[index]?.text;
    const after = located?.[index + 1]?.text;
    result.push({
      type: "break",
      ...(before && after ? { position: { start: before.end, end: after.start } } : {}),
    });
  });
  return result;
}

/** One source line per fragment, or undefined when the node's source can't be read that way. */
function locate(fragments: readonly string[], node: Text, source: string, lines: readonly number[]): { text: Position }[] | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  const raw = source.slice(start, end);
  const segments: { from: number; text: string }[] = [];
  const endings = /\r\n|\r|\n/gu;
  let from = 0;
  for (let match = endings.exec(raw); match; match = endings.exec(raw)) {
    segments.push({ from, text: raw.slice(from, match.index) });
    from = match.index + match[0].length;
  }
  segments.push({ from, text: raw.slice(from) });
  if (segments.length !== fragments.length) return undefined;
  return fragments.map((fragment, index) => {
    const segment = segments[index]!;
    // Spaces before a line ending are not text; the last line's trailing spaces are.
    const content = index < segments.length - 1 ? segment.text.replace(/[ \t]+$/u, "") : segment.text;
    // Verbatim text ends its line. A line with a backslash or ampersand may hold
    // an escape or entity whose source sits outside the matched text, so it keeps
    // the whole line, where source mapping credits the latest editor of each
    // encoded character. Never another line.
    const verbatim = !/[\\&]/u.test(content) && content.endsWith(fragment);
    const lineStart = start + segment.from;
    const textStart = verbatim ? lineStart + content.length - fragment.length : lineStart;
    const textEnd = lineStart + content.length;
    return { text: { start: point(textStart, lines), end: point(textEnd, lines) } };
  });
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 10) starts.push(index + 1);
    else if (code === 13 && source.charCodeAt(index + 1) !== 10) starts.push(index + 1);
  }
  return starts;
}

function point(offset: number, lines: readonly number[]): Point {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lines[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lines[low]! + 1, offset };
}
