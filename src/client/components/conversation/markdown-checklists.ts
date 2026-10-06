export interface MarkdownChecklistToggle {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly checked: boolean;
}

export interface MarkdownChecklistControls {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onToggle: (change: MarkdownChecklistToggle) => void;
}

interface ChecklistNode {
  type: string;
  tagName?: string;
  value?: string;
  data?: { hProperties?: Record<string, unknown> };
  properties?: Record<string, unknown>;
  children?: ChecklistNode[];
}

/**
 * Capture the actual GFM check-value token, before it disappears from the AST.
 * Enter handlers supplement GFM's exit handlers; parsing and checked-state
 * recognition remain entirely with remark-gfm. Positions are UTF-16 offsets.
 */
export function remarkChecklistPositions(this: {
  data(): { fromMarkdownExtensions?: unknown[] };
}): (tree: ChecklistNode, file: { value?: unknown }) => void {
  function capture(
    this: { stack: ChecklistNode[] },
    token: { start: { offset: number }; end: { offset: number } },
  ): void {
    const item = this.stack.at(-2);
    if (item?.type !== "listItem") return;
    const properties = ((item.data ??= {}).hProperties ??= {});
    properties["data-checklist-start"] = token.start.offset;
    properties["data-checklist-end"] = token.end.offset;
  }
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      taskListCheckValueChecked: capture,
      taskListCheckValueUnchecked: capture,
    },
  });
  return (tree, file) => {
    // micromark drops an initial BOM before counting offsets. Restore source
    // coordinates without changing the document the user will save.
    if (typeof file.value !== "string" || !file.value.startsWith("\uFEFF")) return;
    function correct(node: ChecklistNode): void {
      const properties = node.data?.hProperties;
      if (properties) {
        for (const key of ["data-checklist-start", "data-checklist-end"]) {
          if (typeof properties[key] === "number") properties[key] += 1;
        }
      }
      for (const child of node.children ?? []) correct(child);
    }
    correct(tree);
  };
}

/** Attach the source token to the synthetic GFM input, including loose lists. */
export function rehypeChecklistInputs(): (tree: ChecklistNode) => void {
  return function visit(node) {
    if (node.tagName === "li" && node.properties) {
      const start = node.properties["data-checklist-start"];
      const end = node.properties["data-checklist-end"];
      const paragraph = node.children?.find(child => child.tagName === "p");
      const children = paragraph?.children ?? node.children;
      const input = children?.find(child => child.tagName === "input" && child.properties?.type === "checkbox");
      if (input && typeof start === "number" && typeof end === "number") {
        input.properties = {
          ...input.properties,
          "data-checklist-start": start,
          "data-checklist-end": end,
          "aria-label": (children ?? []).map(labelText).join("").replace(/\s+/gu, " ").trim() || "Checklist item",
        };
      }
      delete node.properties["data-checklist-start"];
      delete node.properties["data-checklist-end"];
    }
    for (const child of node.children ?? []) visit(child);
  };
}

function labelText(node: ChecklistNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "img") return String(node.properties?.alt ?? "");
  if (node.tagName === "br") return " ";
  if (node.tagName === "ul" || node.tagName === "ol") return "";
  return (node.children ?? []).map(labelText).join("");
}

/** Validate parser coordinates before exposing an interactive checkbox. */
export function markdownChecklistState(source: string, start: number, end: number): boolean | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end <= start || end >= source.length) return undefined;
  const value = source.slice(start, end);
  if (source[start - 1] !== "[" || source[end] !== "]" || !/^(?:[ xX\t]|\r\n?|\n)$/u.test(value)) return undefined;
  return value === "x" || value === "X";
}

/** Change only the parser-selected marker, preserving the rest of the source. */
export function applyMarkdownChecklistToggle({ source, start, end, checked }: MarkdownChecklistToggle): string | undefined {
  const previous = markdownChecklistState(source, start, end);
  if (previous === undefined || checked === previous) return undefined;
  return source.slice(0, start) + (checked ? "x" : " ") + source.slice(end);
}
