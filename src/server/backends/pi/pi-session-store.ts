import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { createPiCancelledRetryMarker, readPiCancelledRetryMarker } from "./pi-cancelled-retry-marker.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import {
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import { BackendError } from "../contracts.js";
import {
  authenticatedPiToolIdentityNativeToolName,
  assertPiToolIdentityAuthentication,
  createPiToolIdentityMarker,
  isPiToolIdentityMarkerType,
  piToolIdentityMarkerType,
  readPiToolIdentityMarker,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";
import {
  createPiAgentToolInvocationMarker,
  isPiAgentToolInvocationMarkerType,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "./pi-agent-tool-invocation-marker.js";
import {
  createPiContextExcerptMarker,
  isPiContextExcerptMarkerType,
  piContextExcerptMarkerType,
  readPiContextExcerptMarker,
} from "./pi-context-excerpt-marker.js";
import {
  createPiSubmissionAttestation,
  isPiSubmissionAttestationType,
  piSubmissionAttestationType,
  readPiSubmissionAttestation,
} from "./pi-submission-attestation.js";
import {
  createPiBranchMarker,
  isPiBranchMarkerType,
  piBranchMarkerType,
  readPiBranchMarker,
} from "./pi-branch-marker.js";
import {
  isExactPiForkContextBoundary,
  isPiForkContextBoundaryType,
  piForkContextBoundaryType,
} from "./pi-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../fork-context-boundary.js";
import { completedBackendTurnIdForLeaf } from "./pi-branch-checkpoints.js";
import {
  createPiTaskContextMarker,
  isPiTaskContextMarkerType,
  piTaskContextMarkerType,
  readPiTaskContextMarker,
} from "./pi-task-context-marker.js";

const bindingDetailVersion = 1;
const creationMarkerType = "sedes.creation_operation.v1";
const legacyCreationMarkerType = "harness.creation_operation.v1";

function isCreationMarkerType(value: string): boolean {
  return value === creationMarkerType || value === legacyCreationMarkerType;
}

export interface PiBindingDetail {
  readonly version: typeof bindingDetailVersion;
  readonly backendConversationId: string;
  readonly reservedTitle?: string;
  readonly creationOperationId?: string;
  readonly sessionFile?: string;
}

export interface PiSessionStoreOptions {
  readonly sessionDirectory?: string;
  readonly workspacePathMode?: PiWorkspacePathMode;
}

export type PiWorkspacePathMode = "local_canonical" | "remote_semantic";

export interface PiStoredConversation {
  readonly backendConversationId: string;
  readonly canonicalWorkspacePath: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly sessionFile: string;
}

export interface PiStoredConversationWithAncestry extends PiStoredConversation {
  readonly nativeAncestry?: {
    readonly parentBackendConversationId: string;
    readonly sourceLeafEntryId?: string;
    readonly sourceBackendTurnId?: string;
    readonly applicationOperationId?: string;
  };
}

export interface PiReservedConversation {
  readonly manager: SessionManager;
  readonly opaqueBindingDetail: string;
}

function backendError(
  category: "internal" | "not_found" | "rejected",
  message: string,
  code: string,
  crossedSubmissionBoundary = false,
): BackendError {
  return new BackendError({
    category,
    retryable: false,
    crossedSubmissionBoundary,
    safeMessage: message,
    backendCode: code,
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function canonicalRemoteSemanticPath(value: string): string | undefined {
  return normalizedAbsolutePath(value) ? value : undefined;
}

function branchSettingsFingerprint(
  settings: BackendEffectiveSettings | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: settings?.model ?? null,
        thinkingLevel: settings?.thinkingLevel ?? null,
        toolAccess: settings?.toolAccess ?? null,
      }),
    )
    .digest("hex");
}

function reservedBranchSessionFile(
  sessionDirectory: string,
  canonicalWorkspacePath: string,
  targetBackendConversationId: string,
): string {
  const identity = createHash("sha256")
    // This is a permanent provider-storage identity, not a product label. Keep
    // the historical bytes so retries resolve the same reserved session file.
    .update("harness-pi-reserved-branch-v1\0")
    .update(canonicalWorkspacePath)
    .update("\0")
    .update(targetBackendConversationId)
    .digest("hex");
  return path.join(sessionDirectory, `harness-branch-${identity}.jsonl`);
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function normalizeAuthenticatedLegacyNativeToolNames(
  entries: readonly SessionEntry[],
  authentication: PiToolIdentityAuthentication,
): SessionEntry[] {
  const byCallId = new Map<
    string,
    | {
        readonly assistantEntryId: string;
        readonly nativeToolName: string;
        readonly currentToolName: string;
      }
    | undefined
  >();
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      !isPiToolIdentityMarkerType(entry.customType)
    ) {
      continue;
    }
    const result = readPiToolIdentityMarker(entry, authentication);
    const nativeToolName = authenticatedPiToolIdentityNativeToolName(
      entry,
      authentication,
    );
    if (
      result.status !== "authenticated" ||
      !nativeToolName?.startsWith("harness_") ||
      result.marker.toolName === nativeToolName
    ) {
      continue;
    }
    const mapping = {
      assistantEntryId: result.marker.assistantEntryId,
      nativeToolName,
      currentToolName: result.marker.toolName,
    };
    const prior = byCallId.get(result.marker.toolCallId);
    byCallId.set(
      result.marker.toolCallId,
      prior === undefined && !byCallId.has(result.marker.toolCallId)
        ? mapping
        : prior &&
            prior.assistantEntryId === mapping.assistantEntryId &&
            prior.nativeToolName === mapping.nativeToolName &&
            prior.currentToolName === mapping.currentToolName
          ? prior
          : undefined,
    );
  }
  return entries.map((entry) => {
    if (entry.type !== "message") return entry;
    const role = own(entry.message, "role");
    if (role === "assistant" && Array.isArray(own(entry.message, "content"))) {
      const content = own(entry.message, "content") as unknown[];
      let changed = false;
      const normalized = content.map((part) => {
        if (own(part, "type") !== "toolCall") return part;
        const callId = own(part, "id");
        const mapping =
          typeof callId === "string" ? byCallId.get(callId) : undefined;
        if (
          !mapping ||
          mapping.assistantEntryId !== entry.id ||
          own(part, "name") !== mapping.nativeToolName
        ) {
          return part;
        }
        changed = true;
        return { ...(part as object), name: mapping.currentToolName };
      });
      return changed
        ? ({
            ...entry,
            message: { ...entry.message, content: normalized },
          } as SessionEntry)
        : entry;
    }
    if (role === "toolResult") {
      const callId = own(entry.message, "toolCallId");
      const mapping =
        typeof callId === "string" ? byCallId.get(callId) : undefined;
      if (
        mapping &&
        own(entry.message, "toolName") === mapping.nativeToolName
      ) {
        return {
          ...entry,
          message: { ...entry.message, toolName: mapping.currentToolName },
        } as SessionEntry;
      }
    }
    return entry;
  });
}

function resignAuthenticatedConversationMarkers(
  entries: readonly SessionEntry[],
  sourceAuthentication: PiToolIdentityAuthentication,
  targetAuthentication: PiToolIdentityAuthentication,
): SessionEntry[] {
  return normalizeAuthenticatedLegacyNativeToolNames(
    entries,
    sourceAuthentication,
  ).map((entry) => {
    if (entry.type !== "custom") return entry;
    const cancelledRetry = readPiCancelledRetryMarker(entry, sourceAuthentication);
    if (cancelledRetry) return { ...entry, data: createPiCancelledRetryMarker(cancelledRetry, targetAuthentication) };
    if (isPiToolIdentityMarkerType(entry.customType)) {
      const result = readPiToolIdentityMarker(entry, sourceAuthentication);
      if (result.status !== "authenticated") return entry;
      const {
        authentication: _sourceAuthentication,
        version: _sourceVersion,
        ...fields
      } = result.marker;
      return {
        ...entry,
        customType: piToolIdentityMarkerType,
        data: createPiToolIdentityMarker(fields, targetAuthentication),
      };
    }
    if (isPiAgentToolInvocationMarkerType(entry.customType)) {
      const result = readPiAgentToolInvocationMarker(
        entry,
        sourceAuthentication,
      );
      if (result.status !== "authenticated") return entry;
      const {
        authentication: _sourceAuthentication,
        version: _sourceVersion,
        ...fields
      } = result.marker;
      return {
        ...entry,
        customType: piAgentToolInvocationMarkerType,
        data: createPiAgentToolInvocationMarker(fields, targetAuthentication),
      };
    }
    if (isPiSubmissionAttestationType(entry.customType)) {
      const result = readPiSubmissionAttestation(entry, sourceAuthentication);
      if (result.status !== "authenticated") return entry;
      const {
        authentication: _sourceAuthentication,
        version: _sourceVersion,
        ...fields
      } = result.marker;
      return {
        ...entry,
        customType: piSubmissionAttestationType,
        data: createPiSubmissionAttestation(fields, targetAuthentication),
      };
    }
    if (isPiTaskContextMarkerType(entry.customType)) {
      const result = readPiTaskContextMarker(entry, sourceAuthentication);
      if (result.status !== "authenticated") return entry;
      const {
        authentication: _sourceAuthentication,
        version: _sourceVersion,
        ...fields
      } = result.marker;
      return {
        ...entry,
        customType: piTaskContextMarkerType,
        data: createPiTaskContextMarker(fields, targetAuthentication),
      };
    }
    if (!isPiContextExcerptMarkerType(entry.customType)) return entry;
    const result = readPiContextExcerptMarker(entry, sourceAuthentication);
    if (result.status !== "authenticated") return entry;
    const {
      authentication: _sourceAuthentication,
      version: _sourceVersion,
      ...fields
    } = result.marker;
    return {
      ...entry,
      customType: piContextExcerptMarkerType,
      data: createPiContextExcerptMarker(fields, targetAuthentication),
    };
  });
}

export function parsePiBindingDetail(
  detail: string,
  expectedBackendConversationId?: string,
): PiBindingDetail {
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    throw backendError(
      "rejected",
      "The Pi conversation binding is invalid.",
      "pi_binding_detail_invalid",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(
      (key) =>
        key !== "version" &&
        key !== "backendConversationId" &&
        key !== "reservedTitle" &&
        key !== "creationOperationId" &&
        key !== "sessionFile",
    ) ||
    !("version" in value) ||
    value.version !== bindingDetailVersion ||
    !("backendConversationId" in value) ||
    typeof value.backendConversationId !== "string" ||
    !sessionIdValid(value.backendConversationId) ||
    (expectedBackendConversationId !== undefined &&
      value.backendConversationId !== expectedBackendConversationId) ||
    ("reservedTitle" in value &&
      (typeof value.reservedTitle !== "string" ||
        value.reservedTitle.length < 1 ||
        value.reservedTitle.length > 4_096)) ||
    ("creationOperationId" in value &&
      (typeof value.creationOperationId !== "string" ||
        value.creationOperationId.length < 1 ||
        value.creationOperationId.length > 128)) ||
    ("sessionFile" in value &&
      (typeof value.sessionFile !== "string" ||
        value.sessionFile.length < 1 ||
        value.sessionFile.length > 4_096 ||
        !path.isAbsolute(value.sessionFile) ||
        path.normalize(value.sessionFile) !== value.sessionFile)) ||
    Buffer.byteLength(detail, "utf8") > 4_096
  ) {
    throw backendError(
      "rejected",
      "The Pi conversation binding is invalid.",
      "pi_binding_detail_invalid",
    );
  }
  return value as PiBindingDetail;
}

export function extractPiNativeSessionPath(
  opaqueBindingDetail: string,
  expectedBackendConversationId?: string,
): string {
  const detail = parsePiBindingDetail(
    opaqueBindingDetail,
    expectedBackendConversationId,
  );
  if (!detail.sessionFile) {
    throw backendError(
      "rejected",
      "The persisted Pi conversation binding has no session path.",
      "pi_binding_path_missing",
    );
  }
  return detail.sessionFile;
}

/**
 * Serializes the canonical opaque binding detail. The detail carries only
 * backend-owned identity material (conversation id and session path) so the
 * value persisted at creation or branching is byte-identical to the detail
 * discovery recomputes on every scan. Application-authored creation
 * metadata (titles, operation ids) lives in creation-attempt receipts, not
 * in this detail; parsing still tolerates those legacy fields on stored
 * rows.
 */
export function serializePiBindingDetail(
  backendConversationId: string,
  sessionFile?: string,
): string {
  const serialized = JSON.stringify({
    version: bindingDetailVersion,
    backendConversationId,
    ...(sessionFile ? { sessionFile } : {}),
  } satisfies PiBindingDetail);
  parsePiBindingDetail(serialized, backendConversationId);
  return serialized;
}

function sessionIdValid(id: string): boolean {
  return (
    id.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)
  );
}

export class PiSessionStore {
  readonly #sessionDirectory?: string;
  readonly #workspacePathMode: PiWorkspacePathMode;
  readonly #pendingCreationOperations = new Map<string, string>();

  constructor(options: PiSessionStoreOptions = {}) {
    this.#sessionDirectory = options.sessionDirectory
      ? path.resolve(options.sessionDirectory)
      : undefined;
    this.#workspacePathMode = options.workspacePathMode ?? "local_canonical";
    if (
      this.#workspacePathMode === "remote_semantic" &&
      !this.#sessionDirectory
    ) {
      throw new Error("remote_pi_session_directory_required");
    }
  }

  bindingDetail(backendConversationId: string, sessionFile?: string): string {
    return serializePiBindingDetail(backendConversationId, sessionFile);
  }

  transient(workspace: ValidatedWorkspace): SessionManager {
    this.#assertWorkspacePath(workspace.canonicalPath);
    return SessionManager.inMemory(workspace.canonicalPath);
  }

  async list(
    workspace: ValidatedWorkspace,
  ): Promise<readonly PiStoredConversation[]> {
    this.#assertWorkspacePath(workspace.canonicalPath);
    const storeDirectory =
      this.#sessionDirectory ??
      SessionManager.create(workspace.canonicalPath).getSessionDir();
    const canonicalStore = await realpath(storeDirectory).catch(
      () => undefined,
    );
    const sessions =
      this.#workspacePathMode === "remote_semantic"
        ? await SessionManager.listAll(this.#sessionDirectory)
        : await SessionManager.list(
            workspace.canonicalPath,
            this.#sessionDirectory,
          );
    if (sessions.length > 0 && !canonicalStore) {
      throw backendError(
        "internal",
        "The Pi session store could not be validated.",
        "pi_session_store_unavailable",
      );
    }
    const output: PiStoredConversation[] = [];
    for (const session of sessions) {
      const validated = await this.#validateListedSession(
        session,
        workspace.canonicalPath,
        canonicalStore,
      );
      if (validated) output.push(validated);
    }
    return output.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async listWithAncestry(
    workspace: ValidatedWorkspace,
    installationKey: Uint8Array,
    controls: {
      readonly signal?: AbortSignal;
      readonly assertConversationCount?: (count: number) => void;
    } = {},
  ): Promise<readonly PiStoredConversationWithAncestry[]> {
    controls.signal?.throwIfAborted();
    const conversations = await this.list(workspace);
    controls.signal?.throwIfAborted();
    controls.assertConversationCount?.(conversations.length);
    const byCanonicalFile = new Map(
      conversations.map((conversation) => [
        conversation.sessionFile,
        conversation,
      ]),
    );
    const idCounts = new Map<string, number>();
    for (const conversation of conversations) {
      const id = conversation.backendConversationId;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const output: PiStoredConversationWithAncestry[] = [];
    const parentReferences = new Map<
      string,
      {
        readonly parent: PiStoredConversation;
        readonly children: {
          readonly outputIndex: number;
          readonly sourceLeafEntryId: string;
          readonly applicationOperationId: string;
        }[];
      }
    >();

    // Retain only candidate edges, never SessionManagers or transcript bodies.
    // Parents are validated once per canonical file after all children are read.
    for (const conversation of conversations) {
      await scheduler.yield();
      controls.signal?.throwIfAborted();
      const manager = SessionManager.open(
        conversation.sessionFile,
        this.#sessionDirectory,
        workspace.canonicalPath,
      );
      const parentPath = manager.getHeader()?.parentSession;
      const canonicalParent = parentPath
        ? await realpath(parentPath).catch(() => undefined)
        : undefined;
      controls.signal?.throwIfAborted();
      const parent = canonicalParent
        ? byCanonicalFile.get(canonicalParent)
        : undefined;
      if (
        !parent ||
        parent.backendConversationId === conversation.backendConversationId
      ) {
        output.push(conversation);
        continue;
      }
      const outputIndex = output.length;
      output.push({
        ...conversation,
        nativeAncestry: {
          parentBackendConversationId: parent.backendConversationId,
        },
      });
      const childEntries = manager.getBranch();
      const immediateMarkers = childEntries.flatMap((entry) => {
        const result = readPiBranchMarker(entry, installationKey);
        return result.status !== "malformed" &&
          result.marker.sourceBackendConversationId ===
            parent.backendConversationId &&
          result.marker.targetBackendConversationId ===
            conversation.backendConversationId
          ? [result]
          : [];
      });
      const marker =
        immediateMarkers.length === 1 &&
        immediateMarkers[0]?.status === "authenticated"
        ? immediateMarkers[0].marker
        : undefined;
      if (!marker) continue;
      const markerIndex = childEntries.findIndex((entry) => {
        const result = readPiBranchMarker(entry, installationKey);
        return (
          result.status === "authenticated" &&
          result.marker.applicationOperationId === marker.applicationOperationId &&
          result.marker.targetBackendConversationId ===
            conversation.backendConversationId
        );
      });
      const boundarySuffix = childEntries
        .slice(markerIndex + 1)
        .filter(isReservedPiBoundary);
      const boundaryApplied =
        markerIndex >= 0 &&
        boundarySuffix.length === 1 &&
        boundarySuffix[0] === childEntries[markerIndex + 1] &&
        isExactPiForkContextBoundary(
          childEntries[markerIndex + 1],
          marker.applicationOperationId,
          USER_FORK_CONTEXT_BOUNDARY,
        );
      if (boundarySuffix.length !== 0 && !boundaryApplied) continue;
      const references = parentReferences.get(parent.sessionFile) ?? {
        parent,
        children: [],
      };
      references.children.push({
        outputIndex,
        sourceLeafEntryId: marker.sourceLeafEntryId,
        applicationOperationId: marker.applicationOperationId,
      });
      parentReferences.set(parent.sessionFile, references);
    }

    for (const { parent, children } of parentReferences.values()) {
      await scheduler.yield();
      controls.signal?.throwIfAborted();
      const source = SessionManager.open(
        parent.sessionFile,
        this.#sessionDirectory,
        workspace.canonicalPath,
      );
      const activeBranch = source.getBranch();
      const leaves = new Map<
        string,
        { readonly exists: boolean; readonly sourceBackendTurnId?: string }
      >();
      for (const child of children) {
        controls.signal?.throwIfAborted();
        let leaf = leaves.get(child.sourceLeafEntryId);
        if (!leaf) {
          // Existence on an older branch is separate from being a completed
          // turn on the current branch. Only the latter proves exact recovery.
          const exists =
            source.getBranch(child.sourceLeafEntryId).at(-1)?.id ===
            child.sourceLeafEntryId;
          if (exists && (idCounts.get(parent.backendConversationId) ?? 0) > 1) {
            throw backendError(
              "rejected",
              "The Pi conversation ID is ambiguous.",
              "pi_session_id_ambiguous",
            );
          }
          const sourceBackendTurnId = exists
            ? completedBackendTurnIdForLeaf(
                activeBranch,
                child.sourceLeafEntryId,
              )
            : undefined;
          leaf = {
            exists,
            ...(sourceBackendTurnId ? { sourceBackendTurnId } : {}),
          };
          leaves.set(child.sourceLeafEntryId, leaf);
        }
        if (!leaf.exists) continue;
        const conversation = output[child.outputIndex]!;
        output[child.outputIndex] = {
          ...conversation,
          nativeAncestry: {
            parentBackendConversationId: parent.backendConversationId,
            sourceLeafEntryId: child.sourceLeafEntryId,
            applicationOperationId: child.applicationOperationId,
            ...(leaf.sourceBackendTurnId
              ? { sourceBackendTurnId: leaf.sourceBackendTurnId }
              : {}),
          },
        };
      }
    }
    controls.signal?.throwIfAborted();
    return output;
  }

  async reserve(
    workspace: ValidatedWorkspace,
    requestedBackendConversationId?: string,
    title?: string,
    applicationOperationId?: string,
  ): Promise<PiReservedConversation> {
    const backendConversationId =
      requestedBackendConversationId ?? randomUUID();
    if (!sessionIdValid(backendConversationId)) {
      throw backendError(
        "rejected",
        "The requested Pi conversation ID is invalid.",
        "pi_session_id_invalid",
      );
    }
    const existing = await this.#findById(workspace, backendConversationId);
    if (existing) {
      this.#pendingCreationOperations.delete(
        `${workspace.canonicalPath}\0${backendConversationId}`,
      );
      const manager = SessionManager.open(
        existing.sessionFile,
        this.#sessionDirectory,
        workspace.canonicalPath,
      );
      if (
        applicationOperationId &&
        !manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" &&
              isCreationMarkerType(entry.customType) &&
              typeof entry.data === "object" &&
              entry.data !== null &&
              "applicationOperationId" in entry.data &&
              entry.data.applicationOperationId === applicationOperationId,
          )
      ) {
        throw backendError(
          "rejected",
          "The requested Pi conversation ID is already in use.",
          "pi_session_id_collision",
        );
      }
      return {
        manager,
        opaqueBindingDetail: serializePiBindingDetail(
          backendConversationId,
          existing.sessionFile,
        ),
      };
    }
    if (applicationOperationId) {
      const key = `${workspace.canonicalPath}\0${backendConversationId}`;
      const pending = this.#pendingCreationOperations.get(key);
      if (pending && pending !== applicationOperationId) {
        throw backendError(
          "rejected",
          "The requested Pi conversation ID is already reserved.",
          "pi_session_id_collision",
        );
      }
      this.#pendingCreationOperations.set(key, applicationOperationId);
    }
    const manager = SessionManager.create(
      workspace.canonicalPath,
      this.#sessionDirectory,
      { id: backendConversationId },
    );
    if (applicationOperationId) {
      manager.appendCustomEntry(creationMarkerType, {
        applicationOperationId,
      });
    }
    if (title?.trim()) manager.appendSessionInfo(title);
    const sessionFile = manager.getSessionFile();
    const nativeHeader = manager.getHeader();
    // Pi normalizes cwd using the main host OS. Persist the admitted execution
    // host spelling; it is metadata, never a main-host filesystem authority.
    const header = nativeHeader && {
      ...nativeHeader,
      cwd: workspace.canonicalPath,
    };
    if (!sessionFile || !header) {
      throw backendError(
        "internal",
        "Pi could not allocate the conversation.",
        "pi_session_allocation_failed",
      );
    }
    await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        sessionFile,
        `${[header, ...manager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw backendError(
          "rejected",
          "The requested Pi conversation ID is already in use.",
          "pi_session_id_collision",
        );
      }
      throw backendError(
        "internal",
        "Pi could not persist the conversation reservation.",
        "pi_session_reservation_write_failed",
      );
    }
    const canonicalSessionFile = await realpath(sessionFile);
    const persistedManager = SessionManager.open(
      canonicalSessionFile,
      this.#sessionDirectory,
      workspace.canonicalPath,
    );
    return {
      manager: persistedManager,
      opaqueBindingDetail: serializePiBindingDetail(
        backendConversationId,
        canonicalSessionFile,
      ),
    };
  }

  async open(
    workspace: ValidatedWorkspace,
    backendConversationId: string,
    opaqueBindingDetail: string,
  ): Promise<SessionManager> {
    const detail = parsePiBindingDetail(
      opaqueBindingDetail,
      backendConversationId,
    );
    const existing = await this.#findById(workspace, backendConversationId);
    if (existing) {
      if (
        detail.sessionFile &&
        (await realpath(detail.sessionFile).catch(() => undefined)) !==
          existing.sessionFile
      ) {
        throw backendError(
          "rejected",
          "The Pi conversation path does not match its binding.",
          "pi_binding_path_mismatch",
        );
      }
      return SessionManager.open(
        existing.sessionFile,
        this.#sessionDirectory,
        workspace.canonicalPath,
      );
    }
    throw backendError(
      "not_found",
      "The persisted Pi conversation was not found.",
      "pi_session_unavailable",
    );
  }

  async openPersisted(
    workspace: ValidatedWorkspace,
    backendConversationId: string,
  ): Promise<SessionManager | undefined> {
    const existing = await this.#findById(workspace, backendConversationId);
    return existing
      ? SessionManager.open(
          existing.sessionFile,
          this.#sessionDirectory,
          workspace.canonicalPath,
        )
      : undefined;
  }

  async branch(
    sourceWorkspace: ValidatedWorkspace,
    sourceBackendConversationId: string,
    sourceOpaqueBindingDetail: string,
    sourceLeafEntryId: string,
    toolProvenanceKey: Uint8Array,
    requestedBackendConversationId: string,
    applicationOperationId: string,
    title?: string,
    inheritedSettings?: BackendEffectiveSettings,
    targetWorkspace: ValidatedWorkspace = sourceWorkspace,
  ): Promise<PiReservedConversation> {
    const source = await this.open(
      sourceWorkspace,
      sourceBackendConversationId,
      sourceOpaqueBindingDetail,
    );
    const sourceFile = source.getSessionFile();
    if (!sourceFile || !(await stat(sourceFile).catch(() => undefined))) {
      throw backendError(
        "not_found",
        "The Pi source conversation is not persisted.",
        "pi_branch_source_unavailable",
      );
    }
    const branch = source.getBranch(sourceLeafEntryId);
    if (branch.length === 0 || branch.at(-1)?.id !== sourceLeafEntryId) {
      throw backendError(
        "not_found",
        "The Pi branch checkpoint was not found.",
        "pi_checkpoint_not_found",
      );
    }

    const targetId = requestedBackendConversationId;
    if (!sessionIdValid(targetId) || targetId === sourceBackendConversationId) {
      throw backendError(
        "rejected",
        "The requested Pi branch ID is invalid.",
        "pi_branch_id_invalid",
      );
    }
    const sourceAuthentication = {
      conversationId: sourceBackendConversationId,
      installationKey: toolProvenanceKey,
    };
    const targetAuthentication = {
      conversationId: targetId,
      installationKey: toolProvenanceKey,
    };
    assertPiToolIdentityAuthentication(sourceAuthentication);
    assertPiToolIdentityAuthentication(targetAuthentication);
    const canonicalSource = await realpath(sourceFile);
    const inheritedSettingsFingerprint =
      branchSettingsFingerprint(inheritedSettings);
    const existing = await this.#findById(targetWorkspace, targetId);
    if (existing) {
      return this.#validateBranchReplay(targetWorkspace, existing, {
        canonicalSource,
        sourceBackendConversationId,
        targetBackendConversationId: targetId,
        sourceLeafEntryId,
        applicationOperationId,
        inheritedSettingsFingerprint,
        toolProvenanceKey,
      });
    }

    const target = SessionManager.create(
      targetWorkspace.canonicalPath,
      this.#sessionDirectory,
      { id: targetId, parentSession: canonicalSource },
    );
    const generatedTargetFile = target.getSessionFile();
    const nativeHeader = target.getHeader();
    const header = nativeHeader && {
      ...nativeHeader,
      cwd: targetWorkspace.canonicalPath,
    };
    if (!generatedTargetFile || !header) {
      throw backendError(
        "internal",
        "Pi could not allocate the branched conversation.",
        "pi_branch_allocation_failed",
      );
    }
    const targetFile = reservedBranchSessionFile(
      path.dirname(generatedTargetFile),
      targetWorkspace.canonicalPath,
      targetId,
    );
    const entries = resignAuthenticatedConversationMarkers(
      branch,
      sourceAuthentication,
      targetAuthentication,
    );
    const markerManager = SessionManager.inMemory(
      targetWorkspace.canonicalPath,
      {
        id: targetId,
      },
    );
    markerManager.appendCustomEntry(
      piBranchMarkerType,
      createPiBranchMarker(
        {
          sourceBackendConversationId,
          targetBackendConversationId: targetId,
          sourceLeafEntryId,
          applicationOperationId,
          inheritedSettingsFingerprint,
        },
        toolProvenanceKey,
      ),
    );
    if (inheritedSettings?.model) {
      markerManager.appendModelChange(
        inheritedSettings.model.provider,
        inheritedSettings.model.id,
      );
    }
    if (inheritedSettings?.thinkingLevel) {
      markerManager.appendThinkingLevelChange(inheritedSettings.thinkingLevel);
    }
    if (title?.trim()) markerManager.appendSessionInfo(title);
    for (const [index, metadataEntry] of markerManager.getEntries().entries()) {
      entries.push({
        ...metadataEntry,
        ...(index === 0 ? { parentId: entries.at(-1)?.id ?? null } : {}),
      });
    }
    await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        targetFile,
        `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const raced = await this.#findById(targetWorkspace, targetId);
          if (raced) {
            return this.#validateBranchReplay(
              targetWorkspace,
              raced,
              {
                canonicalSource,
                sourceBackendConversationId,
                targetBackendConversationId: targetId,
                sourceLeafEntryId,
                applicationOperationId,
                inheritedSettingsFingerprint,
                toolProvenanceKey,
              },
              true,
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw backendError(
          "rejected",
          "The requested Pi branch ID is already in use.",
          "pi_branch_id_collision",
          true,
        );
      }
      throw backendError(
        "internal",
        "Pi could not persist the branched conversation.",
        "pi_branch_write_failed",
        true,
      );
    }
    return {
      manager: SessionManager.open(
        await realpath(targetFile),
        this.#sessionDirectory,
        targetWorkspace.canonicalPath,
      ),
      opaqueBindingDetail: serializePiBindingDetail(
        targetId,
        await realpath(targetFile),
      ),
    };
  }

  async #validateBranchReplay(
    workspace: ValidatedWorkspace,
    existing: PiStoredConversation,
    expected: {
      readonly canonicalSource: string;
      readonly sourceBackendConversationId: string;
      readonly targetBackendConversationId: string;
      readonly sourceLeafEntryId: string;
      readonly applicationOperationId: string;
      readonly inheritedSettingsFingerprint: string;
      readonly toolProvenanceKey: Uint8Array;
    },
    crossedSubmissionBoundary = false,
  ): Promise<PiReservedConversation> {
    const manager = SessionManager.open(
      existing.sessionFile,
      this.#sessionDirectory,
      workspace.canonicalPath,
    );
    const headerParent = manager.getHeader()?.parentSession;
    const canonicalParent = headerParent
      ? await realpath(headerParent).catch(() => undefined)
      : undefined;
    const immediateMarkers = manager.getBranch().flatMap((entry) => {
      const result = readPiBranchMarker(entry, expected.toolProvenanceKey);
      return result.status !== "malformed" &&
        result.marker.sourceBackendConversationId ===
          expected.sourceBackendConversationId &&
        result.marker.targetBackendConversationId ===
          expected.targetBackendConversationId
        ? [result]
        : [];
    });
    const marker =
      immediateMarkers.length === 1 &&
      immediateMarkers[0]?.status === "authenticated"
        ? immediateMarkers[0].marker
        : undefined;
    const branchEntries = manager.getBranch();
    const markerIndex = marker
      ? branchEntries.findIndex((entry) => {
          const result = readPiBranchMarker(entry, expected.toolProvenanceKey);
          return (
            result.status === "authenticated" &&
            result.marker.applicationOperationId ===
              expected.applicationOperationId &&
            result.marker.targetBackendConversationId ===
              expected.targetBackendConversationId
          );
        })
      : -1;
    const boundaryEntry = branchEntries[markerIndex + 1];
    const boundarySuffix = branchEntries
      .slice(markerIndex + 1)
      .filter(isReservedPiBoundary);
    const historicalBoundaryValid =
      boundarySuffix.length === 0 ||
      (boundarySuffix.length === 1 &&
        boundarySuffix[0] === boundaryEntry &&
        isExactPiForkContextBoundary(
          boundaryEntry,
          expected.applicationOperationId,
          USER_FORK_CONTEXT_BOUNDARY,
        ));
    if (
      canonicalParent !== expected.canonicalSource ||
      !marker ||
      marker.sourceBackendConversationId !==
        expected.sourceBackendConversationId ||
      marker.targetBackendConversationId !==
        expected.targetBackendConversationId ||
      marker.sourceLeafEntryId !== expected.sourceLeafEntryId ||
      marker.applicationOperationId !== expected.applicationOperationId ||
      marker.inheritedSettingsFingerprint !==
        expected.inheritedSettingsFingerprint ||
      markerIndex < 0 ||
      !historicalBoundaryValid
    ) {
      throw backendError(
        "rejected",
        "The requested Pi branch ID is already in use.",
        "pi_branch_id_collision",
        crossedSubmissionBoundary,
      );
    }
    return {
      manager,
      opaqueBindingDetail: serializePiBindingDetail(
        expected.targetBackendConversationId,
        existing.sessionFile,
      ),
    };
  }

  async #findById(
    workspace: ValidatedWorkspace,
    backendConversationId: string,
  ): Promise<PiStoredConversation | undefined> {
    const matches = (await this.list(workspace)).filter(
      (session) => session.backendConversationId === backendConversationId,
    );
    if (matches.length > 1) {
      throw backendError(
        "rejected",
        "The Pi conversation ID is ambiguous.",
        "pi_session_id_ambiguous",
      );
    }
    return matches[0];
  }

  #assertWorkspacePath(canonicalWorkspacePath: string): void {
    if (
      this.#workspacePathMode === "remote_semantic" &&
      canonicalRemoteSemanticPath(canonicalWorkspacePath) === undefined
    ) {
      throw backendError(
        "rejected",
        "The remote Pi workspace path is invalid.",
        "pi_remote_workspace_path_invalid",
      );
    }
  }

  async #validateListedSession(
    session: SessionInfo,
    canonicalWorkspacePath: string,
    canonicalStore: string | undefined,
  ): Promise<PiStoredConversation | undefined> {
    try {
      const [canonicalFile, canonicalCwd] =
        this.#workspacePathMode === "remote_semantic"
          ? ([
              await realpath(session.path),
              canonicalRemoteSemanticPath(session.cwd),
            ] as const)
          : await Promise.all([realpath(session.path), realpath(session.cwd)]);
      if (canonicalCwd !== canonicalWorkspacePath) return undefined;
      if (canonicalStore) {
        if (!isWithin(canonicalStore, canonicalFile)) return undefined;
      }
      if (!sessionIdValid(session.id)) {
        return undefined;
      }
      const title = normalizedSessionTitle(session.name);
      return {
        backendConversationId: session.id,
        canonicalWorkspacePath,
        ...(title ? { title } : {}),
        updatedAt: session.modified.toISOString(),
        sessionFile: canonicalFile,
      };
    } catch {
      return undefined;
    }
  }
}

function normalizedSessionTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 240) return normalized;
  let bounded = normalized.slice(0, 240);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded.trimEnd() || undefined;
}

function isReservedPiBoundary(entry: SessionEntry): boolean {
  return (
    entry.type === "custom_message" &&
    isPiForkContextBoundaryType(entry.customType)
  );
}
