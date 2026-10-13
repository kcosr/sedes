import { z } from "zod";
import { threadIdSchema } from "./protocol/domain.js";

export const MAXIMUM_THREAD_REFERENCES = 8;
export const THREAD_REFERENCE_HEADER =
  "Sedes thread references selected for this message:";

export const threadReferenceSchema = z.strictObject({
  threadId: threadIdSchema,
  title: z.string().min(1).max(512),
});
export type ThreadReference = z.infer<typeof threadReferenceSchema>;

const referenceBlockSchema = z.strictObject({
  threadReferences: z.array(threadReferenceSchema).min(1).max(MAXIMUM_THREAD_REFERENCES)
    .refine((items) => new Set(items.map(({ threadId }) => threadId)).size === items.length),
});

function codeFenceRanges(value: string): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  let fence: { character: string; length: number; start: number } | undefined;
  for (const match of value.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const marker = match[1]!;
    if (!fence) fence = { character: marker[0]!, length: marker.length, start: match.index };
    else if (marker[0] === fence.character && marker.length >= fence.length && !match[2]!.trim()) {
      ranges.push([fence.start, match.index + match[0].length]);
      fence = undefined;
    }
  }
  if (fence) ranges.push([fence.start, value.length]);
  return ranges;
}

/**
 * Explicitly selected references are ordinary user text, so every existing
 * draft, stash, delivery snapshot and provider preserves them without a second
 * persistence contract. This is descriptive context, never tool authority or
 * an instruction to execute another thread's work.
 */
export function formatThreadReferenceText(
  text: string,
  references: readonly ThreadReference[],
): string {
  if (references.length === 0) return text;
  const block = referenceBlockSchema.parse({ threadReferences: references });
  return `${THREAD_REFERENCE_HEADER}\n${JSON.stringify(block)}\n\n${text}`;
}

/**
 * Only an exact, canonical block is presented as chips. Unknown fields,
 * malformed JSON, duplicate IDs, excessive references and noncanonical text
 * remain visible verbatim. Multiple blocks can result from appending a stash
 * or restoring a failed delivery; later titles win for the same stable ID.
 */
export function splitThreadReferenceText(value: string): {
  readonly text: string;
  readonly references: readonly ThreadReference[];
} {
  if (!value.includes(`${THREAD_REFERENCE_HEADER}\n`)) return { text: value, references: [] };
  const references = new Map<string, ThreadReference>();
  const fences = codeFenceRanges(value);
  let fenceIndex = 0;
  const pattern = /^Sedes thread references selected for this message:\n([^\n]*)\n\n/gm;
  const text = value.replace(pattern, (whole: string, json: string, offset: number) => {
    if (offset !== 0 && value.slice(offset - 2, offset) !== "\n\n") return whole;
    if (json.length > 32_768) return whole;
    try {
      const parsed = referenceBlockSchema.safeParse(JSON.parse(json));
      if (!parsed.success || JSON.stringify(parsed.data) !== json) return whole;
      while (fences[fenceIndex] && fences[fenceIndex]![1] <= offset) fenceIndex += 1;
      if (fences[fenceIndex] && fences[fenceIndex]![0] <= offset) return whole;
      const ids = new Set([...references.keys(), ...parsed.data.threadReferences.map(({ threadId }) => threadId)]);
      if (ids.size > MAXIMUM_THREAD_REFERENCES) return whole;
      for (const reference of parsed.data.threadReferences) references.set(reference.threadId, reference);
      return "";
    } catch {
      return whole;
    }
  });
  return { text, references: [...references.values()] };
}

export function replaceThreadReferenceBody(value: string, text: string): string {
  return formatThreadReferenceText(text, splitThreadReferenceText(value).references);
}
