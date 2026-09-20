import type { WorkspaceFileAddress } from "./workspace-file-editor-state.js";
import {
  workspaceFilePathSchema,
  workspaceFileRootIdSchema,
  workspaceFileRootVisibilitySchema,
  type WorkspaceFileRootVisibility,
} from "../../shared/index.js";

export interface WorkspaceFilesOpenIntent extends WorkspaceFileAddress {
  readonly kind: "open-workspace-file";
  readonly workspaceId: string;
  readonly rootVisibility: WorkspaceFileRootVisibility;
  readonly target: WorkspaceFilesOpenTarget;
  readonly sequence: number;
}

export type WorkspaceFilesOpenTarget =
  | { readonly kind: "file" }
  | { readonly kind: "source_line"; readonly lineNumber: number };

export interface WorkspaceFileSourceLineSeek {
  readonly sequence: number;
  readonly lineNumber: number;
}

export function isWorkspaceFilesOpenIntent(
  value: unknown,
): value is WorkspaceFilesOpenIntent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceFilesOpenIntent>;
  return (
    candidate.kind === "open-workspace-file" &&
    typeof candidate.workspaceId === "string" &&
    candidate.workspaceId.length > 0 &&
    workspaceFileRootIdSchema.safeParse(candidate.rootId).success &&
    workspaceFilePathSchema.safeParse(candidate.path).success &&
    workspaceFileRootVisibilitySchema.safeParse(candidate.rootVisibility)
      .success &&
    isWorkspaceFilesOpenTarget(candidate.target) &&
    typeof candidate.sequence === "number" &&
    Number.isSafeInteger(candidate.sequence)
  );
}

function isWorkspaceFilesOpenTarget(
  value: unknown,
): value is WorkspaceFilesOpenTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly lineNumber?: unknown;
  };
  if (candidate.kind === "file") {
    return Object.keys(value).length === 1;
  }
  return (
    candidate.kind === "source_line" &&
    Object.keys(value).length === 2 &&
    typeof candidate.lineNumber === "number" &&
    Number.isSafeInteger(candidate.lineNumber) &&
    candidate.lineNumber > 0
  );
}

let nextSequence = 0;
export function createWorkspaceFilesOpenIntent(
  input: Omit<WorkspaceFilesOpenIntent, "kind" | "sequence">,
): WorkspaceFilesOpenIntent {
  nextSequence = (nextSequence + 1) % Number.MAX_SAFE_INTEGER;
  return { kind: "open-workspace-file", ...input, sequence: nextSequence };
}
