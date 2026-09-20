import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { diffChars } from "diff";
import { createPortal } from "react-dom";
import type { WorkpadAttributionSpan } from "../../shared/protocol/workpads.js";
import { MarkdownContent } from "../components/conversation/MarkdownContent.js";
import "./WorkpadDocument.css";

interface DocumentNode {
  type: string;
  tagName?: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  properties?: Record<string, unknown>;
  children?: DocumentNode[];
}

export interface WorkpadDocumentProps {
  active?: boolean;
  content: string;
  attribution: readonly WorkpadAttributionSpan[];
  showAttribution: boolean;
}

/** A complete rendered document. Removed text is intentionally only in history. */
export function WorkpadDocument({ content, attribution, showAttribution, active = true }: WorkpadDocumentProps) {
  const [selected, setSelected] = useState<{ content: string; span: WorkpadAttributionSpan; top: number; left: number }>();
  useEffect(() => {
    if (!active || !selected) return;
    const dismiss = () => setSelected(undefined);
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-workpad-attribution], .workpad-attribution-detail")) dismiss();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [active, selected]);
  const plugins = useMemo(() => showAttribution
    ? [() => (tree: DocumentNode) => annotate(tree, content, attribution)]
    : [], [content, attribution, showAttribution]);
  const detail = active && showAttribution && selected?.content === content && attribution.includes(selected.span)
    ? selected.span : undefined;
  const select = (target: EventTarget | null) => {
    const mark = target instanceof Element ? target.closest<HTMLElement>("[data-workpad-attribution]") : null;
    if (!mark) return false;
    const span = attribution[Number(mark.dataset.workpadAttribution)];
    if (!span) return false;
    const bounds = mark.getBoundingClientRect();
    setSelected({ content, span,
      top: Math.max(12, Math.min(bounds.bottom + 6, window.innerHeight - 112)),
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - 432)),
    });
    return true;
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    // Links retain their normal navigation behavior and expose attribution on hover.
    if (event.target instanceof Element && event.target.closest("a")) return;
    select(event.target);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && selected) {
      event.preventDefault();
      event.stopPropagation();
      setSelected(undefined);
    }
    if ((event.key === "Enter" || event.key === " ") && select(event.target)) event.preventDefault();
  };
  return (
    <div className="workpad-document" onClick={click} onKeyDown={keyDown}
      onMouseOver={event => { select(event.target); }} onFocus={event => { select(event.target); }}>
      <MarkdownContent rehypePlugins={plugins} enableMermaid={!showAttribution}>{content}</MarkdownContent>
      {detail && selected && createPortal(<aside className="workpad-attribution-detail" style={{ top: selected.top, left: selected.left }} aria-label="Attribution details" data-selection-action-overlay="" role="status">
        <span><strong>{authorName(detail)}</strong><span className="workpad-attribution-meta"> · Revision {detail.revision} · <time dateTime={detail.createdAt}>{new Date(detail.createdAt).toLocaleString()}</time></span></span>
        <button type="button" aria-label="Close attribution details" onClick={() => setSelected(undefined)}>×</button>
      </aside>, document.body)}
    </div>
  );
}

function authorName(span: WorkpadAttributionSpan): string {
  return span.author.kind === "user" ? "You" : span.author.name || span.author.nameSnapshot;
}

function authorColor(span: WorkpadAttributionSpan): number {
  if (span.author.kind === "user") return 0;
  const key = span.author.threadId ?? span.author.clientId ?? span.author.nameSnapshot;
  let hash = 0;
  for (const character of key) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return 1 + hash % 5;
}

function spanAt(spans: readonly WorkpadAttributionSpan[], offset: number): number {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const span = spans[mid]!;
    if (offset < span.start) high = mid - 1;
    else if (offset >= span.end) low = mid + 1;
    else return mid;
  }
  return -1;
}

/** Map Markdown text leaves back to source without interpreting markup as visible text. */
function sourceOffsets(source: string, value: string, start: number, spans: readonly WorkpadAttributionSpan[], code: boolean): number[] | undefined {
  if (!code && source !== value && /[&\\]/u.test(source)) {
    const offsets: number[] = [];
    let normalized = "";
    for (let i = 0; i < source.length;) {
      const rest = source.slice(i);
      const entity = /^&(?:#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/iu.exec(rest)?.[0];
      const escaped = /^\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.exec(rest)?.[0];
      let decoded: string | undefined;
      const encoded = entity ?? escaped;
      if (entity) {
        // Only a single syntactically bounded character reference enters the decoder.
        const decoder = document.createElement("textarea");
        decoder.innerHTML = entity;
        decoded = decoder.value;
      } else if (escaped) decoded = escaped.slice(1);
      if (encoded && decoded !== undefined) {
        let anchor = start + i;
        for (let j = 1; j < encoded.length; j++) {
          const candidate = start + i + j;
          if ((spans[spanAt(spans, candidate)]?.revision ?? -1) > (spans[spanAt(spans, anchor)]?.revision ?? -1)) anchor = candidate;
        }
        normalized += decoded;
        offsets.push(...Array.from({ length: decoded.length }, () => anchor));
        i += encoded.length;
      } else {
        normalized += source[i]!;
        offsets.push(start + i++);
      }
    }
    const normalizedOffsets = sourceOffsets(normalized, value, 0, spans, true);
    return normalizedOffsets?.map(offset => offsets[offset] ?? start);
  }
  if (source === value) return Array.from({ length: value.length }, (_, i) => start + i);
  const diff = diffChars(source, value, { timeout: 20, maxEditLength: 2048 });
  if (!diff) return undefined;
  const offsets: number[] = [];
  let cursor = start;
  let removedStart: number | undefined;
  for (const change of diff) {
    if (change.removed) {
      removedStart = cursor;
      cursor += change.value.length;
    } else if (change.added) {
      // Decoded entities and normalized whitespace may not exist verbatim in source.
      const anchor = removedStart ?? Math.min(cursor, start + Math.max(0, source.length - 1));
      for (let i = 0; i < change.value.length; i++) offsets.push(anchor);
      removedStart = undefined;
    } else {
      for (let i = 0; i < change.value.length; i++) offsets.push(cursor + i);
      cursor += change.value.length;
      removedStart = undefined;
    }
  }
  return offsets;
}

function annotate(node: DocumentNode, source: string, spans: readonly WorkpadAttributionSpan[], inCode = false): void {
  const code = inCode || node.tagName === "code";
  if (!node.children) return;
  node.children = node.children.flatMap(child => {
    if (child.type !== "text" || !child.value) {
      annotate(child, source, spans, code);
      return [child];
    }
    // Code leaves inherit positions from their containing code element.
    const position = child.position ?? (node.tagName === "code" ? node.position : undefined);
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (start === undefined || end === undefined) return [child];
    const offsets = sourceOffsets(source.slice(start, end), child.value, start, spans, code);
    if (!offsets) return [child];
    const pieces: DocumentNode[] = [];
    let from = 0;
    while (from < child.value.length) {
      const index = spanAt(spans, offsets[from]!);
      let to = from + 1;
      while (to < child.value.length && spanAt(spans, offsets[to]!) === index) to++;
      const text: DocumentNode = { type: "text", value: child.value.slice(from, to) };
      const span = spans[index];
      pieces.push(span ? {
        type: "element", tagName: "mark", properties: {
          className: `workpad-attribution workpad-attribution-${authorColor(span)}`,
          "data-workpad-attribution": String(index),
          tabIndex: 0, role: "button",
          title: `${authorName(span)} · Revision ${span.revision} · ${new Date(span.createdAt).toLocaleString()}`,
          "aria-label": `${text.value} — last changed by ${authorName(span)}, revision ${span.revision}`,
        }, children: [text],
      } : text);
      from = to;
    }
    return pieces;
  });
}
