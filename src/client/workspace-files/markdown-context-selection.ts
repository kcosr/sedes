import type { ContextExcerptLocator } from "../../shared/index.js";

const MARKDOWN_BLOCK_SELECTOR = "[data-markdown-block]";
const MARKDOWN_HEADING_SELECTOR =
  "h1[data-markdown-block],h2[data-markdown-block],h3[data-markdown-block],h4[data-markdown-block],h5[data-markdown-block],h6[data-markdown-block]";

export interface MarkdownContextSelection {
  readonly excerpt: string;
  readonly locator: Extract<ContextExcerptLocator, { kind: "text_quote" }>;
}

export interface MarkdownContextSelectionOptions {
  readonly maximumAffixBytes: number;
  readonly maximumHeadingEntries: number;
  readonly maximumHeadingBytes: number;
}

/** Captures an immutable visible-text quote plus non-authoritative source hints. */
export function captureMarkdownContextSelection(
  root: HTMLElement,
  range: Range,
  options: MarkdownContextSelectionOptions,
): MarkdownContextSelection | undefined {
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return undefined;
  }
  const excerpt = range.toString();
  if (!excerpt.trim()) return undefined;

  const startBlock = closestMarkdownBlock(range.startContainer);
  const endBlock = closestMarkdownBlock(range.endContainer);
  if (
    !startBlock ||
    !endBlock ||
    !root.contains(startBlock) ||
    !root.contains(endBlock)
  ) {
    return undefined;
  }

  const sourceStartLine = positiveDatasetInteger(
    startBlock.dataset.markdownSourceStartLine,
  );
  const sourceEndLine = positiveDatasetInteger(
    endBlock.dataset.markdownSourceEndLine,
  );
  const prefix = capturePrefix(startBlock, range, options.maximumAffixBytes);
  const suffix = captureSuffix(endBlock, range, options.maximumAffixBytes);
  const headingTrail = captureHeadingTrail(root, startBlock, options);

  return {
    excerpt,
    locator: {
      kind: "text_quote",
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      ...(headingTrail.length > 0 ? { headingTrail } : {}),
      ...(sourceStartLine !== undefined && sourceEndLine !== undefined
        ? { sourceStartLine, sourceEndLine }
        : {}),
    },
  };
}

function closestMarkdownBlock(node: Node): HTMLElement | undefined {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(MARKDOWN_BLOCK_SELECTOR) ?? undefined;
}

function capturePrefix(
  block: HTMLElement,
  selected: Range,
  maximumBytes: number,
): string | undefined {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(selected.startContainer, selected.startOffset);
    return takeUtf8Tail(range.toString(), maximumBytes) || undefined;
  } catch {
    return undefined;
  }
}

function captureSuffix(
  block: HTMLElement,
  selected: Range,
  maximumBytes: number,
): string | undefined {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setStart(selected.endContainer, selected.endOffset);
    return takeUtf8Head(range.toString(), maximumBytes) || undefined;
  } catch {
    return undefined;
  }
}

function captureHeadingTrail(
  root: HTMLElement,
  startBlock: HTMLElement,
  options: MarkdownContextSelectionOptions,
): string[] {
  const trail: string[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>(
    MARKDOWN_HEADING_SELECTOR,
  )) {
    const isStartHeading = heading === startBlock;
    if (
      !isStartHeading &&
      !(
        heading.compareDocumentPosition(startBlock) &
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    ) {
      continue;
    }
    const level = positiveDatasetInteger(heading.dataset.markdownHeadingLevel);
    const text = takeUtf8Head(
      heading.textContent?.trim() ?? "",
      options.maximumHeadingBytes,
    );
    if (level === undefined || level > 6 || !text) continue;
    trail.length = Math.min(trail.length, level - 1);
    trail[level - 1] = text;
    if (isStartHeading) break;
  }
  return trail.filter(Boolean).slice(-options.maximumHeadingEntries);
}

function positiveDatasetInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function takeUtf8Head(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = utf8Bytes(character);
    if (bytes + nextBytes > maximumBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function takeUtf8Tail(value: string, maximumBytes: number): string {
  const characters = Array.from(value);
  let result = "";
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const nextBytes = utf8Bytes(character);
    if (bytes + nextBytes > maximumBytes) break;
    result = character + result;
    bytes += nextBytes;
  }
  return result;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
