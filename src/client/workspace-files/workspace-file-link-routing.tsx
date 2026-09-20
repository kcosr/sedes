import { createContext, useContext, type ReactNode } from "react";
import {
  workspaceFileAbsolutePathSchema,
  workspaceFilePathSchema,
  type WorkspaceFileLinkReference,
  type WorkspaceFileLinkResolveResult,
  type WorkspaceFileRootId,
} from "../../shared/index.js";
import {
  createWorkspaceFilesOpenIntent,
  type WorkspaceFilesOpenTarget,
  type WorkspaceFilesOpenIntent,
} from "./open-intent.js";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";

export interface WorkspaceFileLinkRequest {
  readonly reference: WorkspaceFileLinkReference;
  readonly target: WorkspaceFilesOpenTarget;
}

export interface WorkspaceFileLinkOpenRequest extends WorkspaceFileLinkRequest {
  /** The click-time presentation decision must survive asynchronous resolution. */
  readonly presentation: PanelPresentation;
}

export interface WorkspaceFileLinkHandler {
  /**
   * Resolve and open a server-authorized link reference in the workspace Files
   * panel. Implementations must not treat this browser-supplied reference as
   * file authority; the server maps it to an opaque rootId + relative path.
   */
  openReference(
    request: WorkspaceFileLinkOpenRequest,
  ): boolean | undefined | Promise<boolean | undefined>;
  /** Prevent a pending resolution from opening a panel after scope changes. */
  dispose?(): void;
}

const WorkspaceFileLinkContext = createContext<
  WorkspaceFileLinkHandler | undefined
>(undefined);

export function WorkspaceFileLinkProvider({
  handler,
  children,
}: {
  readonly handler: WorkspaceFileLinkHandler | undefined;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <WorkspaceFileLinkContext.Provider value={handler}>
      {children}
    </WorkspaceFileLinkContext.Provider>
  );
}

export function useWorkspaceFileLinkHandler():
  WorkspaceFileLinkHandler | undefined {
  return useContext(WorkspaceFileLinkContext);
}

export type MarkdownHrefClassification =
  | { readonly kind: "ordinary" }
  | { readonly kind: "invalid_file" }
  | {
      readonly kind: "workspace_file";
      readonly request: WorkspaceFileLinkRequest;
      readonly explicit: boolean;
    };

export interface MarkdownFileLinkSource {
  readonly rootId: WorkspaceFileRootId;
  readonly path: string;
}

/**
 * Extracts explicit local file URLs and ambiguous POSIX path-shaped links.
 * Containment intentionally is not a browser concern: every candidate still
 * goes through the workspace file-link resolver before a Files-panel address
 * may be opened.
 */
export function classifyMarkdownHref(
  value: string,
  source?: MarkdownFileLinkSource,
): MarkdownHrefClassification {
  if (!value.toLowerCase().startsWith("file:")) {
    return classifyPathShapedHref(value, source);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid_file" };
  }
  if (
    url.protocol !== "file:" ||
    (url.hostname !== "" && url.hostname !== "localhost") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return { kind: "invalid_file" };
  }
  return decodedAbsolutePath(url.href, true);
}

export function createWorkspaceFileLinkHandler({
  threadId,
  workspaceId,
  resolve,
  open,
}: {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly resolve: (
    threadId: string,
    reference: WorkspaceFileLinkReference,
    signal?: AbortSignal,
  ) => Promise<WorkspaceFileLinkResolveResult>;
  readonly open: (
    intent: WorkspaceFilesOpenIntent,
    presentation: PanelPresentation,
  ) => void;
}): WorkspaceFileLinkHandler {
  const controllers = new Set<AbortController>();
  let latestRequest = 0;
  return {
    async openReference(requestInput) {
      const request = ++latestRequest;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const result = await resolve(
          threadId,
          requestInput.reference,
          controller.signal,
        );
        if (controller.signal.aborted || request !== latestRequest)
          return undefined;
        if (result.status !== "resolved") return false;
        open(
          createWorkspaceFilesOpenIntent({
            workspaceId,
            rootId: result.rootId,
            path: result.path,
            rootVisibility: result.rootVisibility,
            target: requestInput.target,
          }),
          requestInput.presentation,
        );
        return true;
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return undefined;
        }
        throw error;
      } finally {
        controllers.delete(controller);
      }
    },
    dispose() {
      latestRequest += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

function decodedAbsolutePath(
  value: string,
  explicit: boolean,
): MarkdownHrefClassification {
  try {
    let decoded = decodeURIComponent(
      explicit ? new URL(value).pathname : value,
    );
    // File URLs serialize drive paths as /C:/dir/file. The wire reference
    // retains the execution environment's native canonical path spelling.
    if (explicit && /^\/[a-z]:\//iu.test(decoded))
      decoded = decoded.slice(1).replaceAll("/", "\\");
    const locatedPath = splitSourceLineSuffix(decoded);
    if (!workspaceFileAbsolutePathSchema.safeParse(locatedPath.path).success) {
      return explicit ? { kind: "invalid_file" } : { kind: "ordinary" };
    }
    return {
      kind: "workspace_file",
      request: {
        reference: { kind: "absolute", path: locatedPath.path },
        target: locatedPath.target,
      },
      explicit,
    };
  } catch {
    // Explicit file URLs fail closed. Ambiguous path-shaped links retain their
    // ordinary browser behavior when they are not valid workspace references.
    return explicit ? { kind: "invalid_file" } : { kind: "ordinary" };
  }
}

function classifyPathShapedHref(
  value: string,
  source?: MarkdownFileLinkSource,
): MarkdownHrefClassification {
  if (
    value === "" ||
    value.startsWith("//") ||
    value.startsWith("#") ||
    value.startsWith("?") ||
    value.includes("#") ||
    value.includes("?")
  ) {
    return { kind: "ordinary" };
  }
  if (
    value.startsWith("/") ||
    /^[a-z]:\\/iu.test(value) ||
    value.startsWith("\\\\")
  )
    return decodedAbsolutePath(value, false);

  try {
    const decoded = decodeURIComponent(value);
    const locatedPath = splitSourceLineSuffix(decoded);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(locatedPath.path)) {
      return { kind: "ordinary" };
    }
    const relativePath = source
      ? resolveRelativeFilePath(source.path, locatedPath.path)
      : locatedPath.path.startsWith("./")
        ? locatedPath.path.slice(2)
        : locatedPath.path;
    if (relativePath === undefined) return { kind: "invalid_file" };
    if (!workspaceFilePathSchema.safeParse(relativePath).success) {
      return { kind: "ordinary" };
    }
    return {
      kind: "workspace_file",
      request: {
        reference: source
          ? { kind: "root_relative", rootId: source.rootId, path: relativePath }
          : { kind: "workspace_relative", path: relativePath },
        target: locatedPath.target,
      },
      explicit: false,
    };
  } catch {
    return { kind: "ordinary" };
  }
}

function resolveRelativeFilePath(
  sourcePath: string,
  linkedPath: string,
): string | undefined {
  if (!workspaceFilePathSchema.safeParse(sourcePath).success) return undefined;
  const segments = sourcePath.split("/");
  segments.pop();
  for (const segment of linkedPath.split("/")) {
    if (segment === "" || segment === ".") {
      if (segment === "") return undefined;
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  return workspaceFilePathSchema.safeParse(resolved).success
    ? resolved
    : undefined;
}

/**
 * Markdown emitted by coding tools commonly appends a one-based source line
 * to a file path (`src/app.ts:42`). The Files resolver authorizes only the
 * stripped file reference; the line remains a transient presentation target.
 */
function splitSourceLineSuffix(value: string): {
  readonly path: string;
  readonly target: WorkspaceFilesOpenTarget;
} {
  const match = /^(.*):([1-9]\d*)$/.exec(value);
  if (!match?.[1]) return { path: value, target: { kind: "file" } };
  const lineNumber = Number(match[2]);
  return Number.isSafeInteger(lineNumber)
    ? {
        path: match[1],
        target: { kind: "source_line", lineNumber },
      }
    : { path: match[1], target: { kind: "file" } };
}

/** Converts normalized operation provenance into a resolver input. */
export function workspaceFileReferenceFromPath(
  value: string,
): WorkspaceFileLinkReference | undefined {
  if (workspaceFileAbsolutePathSchema.safeParse(value).success) {
    return { kind: "absolute", path: value };
  }
  const relativePath = value.startsWith("./") ? value.slice(2) : value;
  return workspaceFilePathSchema.safeParse(relativePath).success
    ? { kind: "workspace_relative", path: relativePath }
    : undefined;
}
