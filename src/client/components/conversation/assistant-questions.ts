import type { Element, ElementContent, Root, RootContent } from "hast";

export const ASSISTANT_QUESTION_SELECTOR = "[data-assistant-question]";
export const ASSISTANT_QUESTION_TEXT_SELECTOR = "[data-assistant-question-text]";
export const ASSISTANT_QUESTION_NOTE_SELECTOR = "button[data-assistant-question-note]";

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const questionMark = /[?？؟]/u;
const questionEnding = /[?？؟][\p{Pe}\p{Pf}"']*$/u;
const formattingTags = new Set(["del", "em", "strong"]);
const inlineTags = new Set([...formattingTags, "a", "br", "code", "img", "sup"]);

interface InlinePart {
  readonly node: ElementContent;
  readonly start: number;
  readonly end: number;
  readonly children?: readonly InlinePart[];
}

/** Decorates settled assistant prose while preserving Markdown block and inline semantics. */
export function rehypeAssistantQuestions(): (tree: Root) => void {
  return (tree) => {
    let nextQuestion = 0;
    const visit = (node: Root | RootContent): void => {
      if (node.type === "element") {
        if (node.tagName === "blockquote") return;
        if (node.tagName === "p" || node.tagName === "li") {
          const children: ElementContent[] = [];
          let inline: ElementContent[] = [];
          const flush = () => {
            for (const child of decorateInline(inline, () => String(++nextQuestion))) {
              children.push(child);
            }
            inline = [];
          };
          for (const child of node.children) {
            if (child.type === "text" || (child.type === "element" && inlineTags.has(child.tagName))) {
              inline.push(child);
            } else {
              // Tight list items contain inline prose alongside nested blocks.
              flush();
              visit(child);
              children.push(child);
            }
          }
          flush();
          node.children = children;
          return;
        }
      }
      if (node.type === "root" || node.type === "element") {
        node.children.forEach(visit);
      }
    };
    visit(tree);
  };
}

function decorateInline(nodes: ElementContent[], nextQuestion: () => string): ElementContent[] {
  const chunks: string[] = [];
  let offset = 0;
  const project = (node: ElementContent): InlinePart => {
    const start = offset;
    if (node.type === "element" && formattingTags.has(node.tagName)) {
      const children = node.children.map(project);
      // Keep empty inline elements in the tree as atomic parts.
      if (offset !== start) return { node, start, end: offset, children };
    }
    // Links and code are atomic. Their internal punctuation does not define
    // sentence boundaries, although they can belong to a surrounding question.
    const text = node.type === "text" && node.value
      ? node.value.replace(/\n/g, " ")
      : node.type === "element" && node.tagName === "br"
        ? "\n"
        : "\uFFFC";
    chunks.push(text);
    offset += text.length;
    return { node, start, end: offset };
  };
  const parts = nodes.map(project);
  const text = chunks.join("");
  if (!questionMark.test(text)) return nodes;

  const children: ElementContent[] = [];
  let from = 0;
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const sentence = segment.trim();
    if (!questionEnding.test(sentence)) continue;
    const start = index + segment.length - segment.trimStart().length;
    const end = start + sentence.length;
    for (const child of sliceInline(parts, from, start)) children.push(child);
    children.push(questionElement(nextQuestion(), sliceInline(parts, start, end)));
    from = end;
  }
  if (from === 0) return nodes;
  for (const child of sliceInline(parts, from, text.length)) children.push(child);
  return children;
}

function sliceInline(parts: readonly InlinePart[], start: number, end: number): ElementContent[] {
  if (start >= end) return [];
  // Find the first overlapping child even if a long paragraph has many questions.
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (parts[mid]!.end <= start) low = mid + 1;
    else high = mid;
  }
  const result: ElementContent[] = [];
  for (let index = low; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.start >= end) break;
    if (start <= part.start && part.end <= end) {
      result.push(part.node);
    } else if (part.node.type === "text") {
      result.push({
        type: "text",
        value: part.node.value.slice(Math.max(0, start - part.start), end - part.start),
      });
    } else if (part.node.type === "element" && part.children) {
      result.push({ ...part.node, children: sliceInline(part.children, start, end) });
    }
  }
  return result;
}

function questionElement(id: string, children: ElementContent[]): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { "data-assistant-question": id },
    children: [
      { type: "element", tagName: "span", properties: { "data-assistant-question-text": "" }, children },
      {
        type: "element",
        tagName: "button",
        properties: {
          "data-assistant-question-note": "",
          type: "button",
          ariaLabel: "Add note to question",
          title: "Add note",
        },
        children: [],
      },
    ],
  };
}
