const MARKDOWN_BLOCK_SELECTOR = "[data-markdown-block]";

export interface MarkdownSourceSeekTarget {
  readonly element: HTMLElement;
  readonly startLine: number;
  readonly endLine: number;
  readonly match: "containing" | "following" | "preceding";
}

/** Finds the rendered block that most truthfully represents a source line. */
export function findMarkdownSourceSeekTarget(
  root: HTMLElement,
  lineNumber: number,
): MarkdownSourceSeekTarget | undefined {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
  const blocks = [...root.querySelectorAll<HTMLElement>(MARKDOWN_BLOCK_SELECTOR)]
    .map((element, order) => {
      const startLine = positiveInteger(
        element.dataset.markdownSourceStartLine,
      );
      const endLine = positiveInteger(element.dataset.markdownSourceEndLine);
      return startLine !== undefined &&
        endLine !== undefined &&
        endLine >= startLine
        ? { element, startLine, endLine, order }
        : undefined;
    })
    .filter((block) => block !== undefined);

  const containing = blocks
    .filter(
      (block) => block.startLine <= lineNumber && block.endLine >= lineNumber,
    )
    .sort(
      (left, right) =>
        Number(right.startLine === lineNumber) -
          Number(left.startLine === lineNumber) ||
        left.endLine - left.startLine - (right.endLine - right.startLine) ||
        left.order - right.order,
    )[0];
  if (containing) return seekTarget(containing, "containing");

  const following = blocks
    .filter((block) => block.startLine > lineNumber)
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.order - right.order,
    )[0];
  if (following) return seekTarget(following, "following");

  const preceding = blocks
    .filter((block) => block.endLine < lineNumber)
    .sort(
      (left, right) =>
        right.endLine - left.endLine || right.order - left.order,
    )[0];
  return preceding ? seekTarget(preceding, "preceding") : undefined;
}

function seekTarget(
  block: {
    readonly element: HTMLElement;
    readonly startLine: number;
    readonly endLine: number;
  },
  match: MarkdownSourceSeekTarget["match"],
): MarkdownSourceSeekTarget {
  return {
    element: block.element,
    startLine: block.startLine,
    endLine: block.endLine,
    match,
  };
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
