import type { Break, Parent, Root, Text } from "mdast";
import type { Point, Position } from "unist";

const LINE_ENDING = /\r\n|\r|\n/gu;

/**
 * Render a soft line break (a single newline inside a paragraph, heading text,
 * list item or table cell) as a hard line break, so text reads as it was typed.
 * Blank lines still separate paragraphs, and code is untouched: only `text`
 * nodes are split. Each fragment keeps an exact source position where the
 * fragment occurs verbatim in the source; otherwise it keeps the whole text
 * node's position, which source mapping aligns by diffing.
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
    LINE_ENDING.lastIndex = 0;
  }
  parent.children = children;
}

function split(node: Text, source: string, lines: readonly number[]): (Text | Break)[] {
  LINE_ENDING.lastIndex = 0;
  const fragments = node.value.split(LINE_ENDING);
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const raw = start !== undefined && end !== undefined ? source.slice(start, end) : undefined;
  const located: (Position | undefined)[] = [];
  let cursor = 0;
  for (const fragment of fragments) {
    const at = raw === undefined ? -1 : raw.indexOf(fragment, cursor);
    if (raw === undefined || start === undefined || at < 0) {
      located.push(undefined);
      continue;
    }
    located.push({ start: point(start + at, lines), end: point(start + at + fragment.length, lines) });
    cursor = at + fragment.length;
  }
  const result: (Text | Break)[] = [];
  fragments.forEach((fragment, index) => {
    const position = located[index] ?? node.position;
    if (fragment) result.push({ type: "text", value: fragment, ...(position ? { position } : {}) });
    if (index === fragments.length - 1) return;
    const after = located[index];
    const next = located[index + 1];
    result.push({
      type: "break",
      ...(after && next ? { position: { start: after.end, end: next.start } } : {}),
    });
  });
  return result;
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
