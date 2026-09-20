interface MarkdownHastPosition {
  readonly start?: { readonly line?: number };
  readonly end?: { readonly line?: number };
}

interface MarkdownHastNode {
  readonly type: string;
  readonly tagName?: string;
  readonly position?: MarkdownHastPosition;
  readonly children?: readonly MarkdownHastNode[];
  properties?: Record<string, unknown>;
}

const POSITIONED_BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "p",
  "pre",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
]);

/**
 * Adds truthful Markdown source-line hints to rendered block elements.
 *
 * These lines come from the Markdown AST. They are deliberately not exposed
 * as DOM/source offsets: rendered text and Markdown bytes diverge around
 * links, escapes, entities, code spans, and other syntax.
 */
export function rehypeMarkdownSourcePositions(): (
  tree: MarkdownHastNode,
) => void {
  return (tree) => visit(tree);
}

function visit(node: MarkdownHastNode): void {
  if (
    node.type === "element" &&
    node.tagName !== undefined &&
    POSITIONED_BLOCK_TAGS.has(node.tagName)
  ) {
    const startLine = node.position?.start?.line;
    const endLine = node.position?.end?.line;
    if (startLine !== undefined && endLine !== undefined) {
      const properties = (node.properties ??= {});
      properties["data-markdown-block"] = "";
      properties["data-markdown-source-start-line"] = String(startLine);
      properties["data-markdown-source-end-line"] = String(endLine);
      if (/^h[1-6]$/.test(node.tagName)) {
        properties["data-markdown-heading-level"] = node.tagName.slice(1);
      }
    }
  }
  for (const child of node.children ?? []) visit(child);
}
