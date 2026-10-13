import { z } from "zod";
import {
  workpadContentSchema, workpadSchema, workpadRevisionSchema,
} from "../../shared/protocol/workpads.js";

/** Only canonical Workpad bodies receive the existing 256K document allowance. */
export const workpadToolOutputSchema = z.strictObject({
  workpad: z.union([
    workpadSchema.omit({ attribution: true }),
    workpadRevisionSchema.omit({ attribution: true, changes: true }),
  ]),
});

export function isWorkpadWriteTool(toolId: unknown): boolean {
  return toolId === "workpad.create" || toolId === "workpad.update";
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Paths, not property names, prevent unrelated nested strings gaining this allowance. */
export function isWorkpadInputContentPath(toolId: string, path: readonly string[]): boolean {
  if (toolId === "workpad.create") return path.length === 1 && path[0] === "content";
  if (toolId !== "workpad.update" || path[0] !== "edit") return false;
  return (path.length === 2 && (path[1] === "content" || path[1] === "text")) ||
    (path.length === 4 && path[1] === "edits" && /^\d+$/u.test(path[2]!) &&
      (path[3] === "oldText" || path[3] === "newText"));
}

/** The same UTF-16/Unicode checks apply before Pi, MCP, HTTP, and CLI dispatch. */
export function workpadInputContentError(toolId: string, input: unknown): string | undefined {
  if (!isWorkpadWriteTool(toolId) || !input || typeof input !== "object") return undefined;
  const texts: unknown[] = toolId === "workpad.create" ? [own(input, "content")] : [];
  const edit = own(input, "edit");
  if (toolId === "workpad.update" && edit && typeof edit === "object") {
    if (own(edit, "kind") === "replace") texts.push(own(edit, "content"));
    if (own(edit, "kind") === "append") texts.push(own(edit, "text"));
    const edits = own(edit, "edits");
    if (own(edit, "kind") === "patch" && Array.isArray(edits)) {
      for (let index = 0; index < Math.min(edits.length, 100); index++) {
        const item = own(edits, String(index));
        if (item && typeof item === "object") texts.push(own(item, "oldText"), own(item, "newText"));
      }
    }
  }
  for (const text of texts) {
    if (typeof text !== "string") continue; // Canonical schemas diagnose wrong types.
    const result = workpadContentSchema.safeParse(text);
    if (!result.success) return result.error.issues[0]!.message;
  }
  return undefined;
}
