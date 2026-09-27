import type { FormInfo, OpenCodeEvent, PermissionRequest, SessionInfo, SessionInboxInfo, SessionMessageInfo,
  SessionMessagesResponse, SessionsResponse, ShellInfo1, FormDetail, ModelInfo, ModelRef, PermissionGetInput,
  PermissionReplyInput, SessionCreateInput, SessionFormCancelInput, SessionFormGetInput,
  SessionFormReplyInput, SessionInboxCancelInput, SessionInboxUser, SessionPromptInput,
  SessionSwitchModelInput, SessionCompactInput, SessionCompactOutput, SessionEventDurable, SessionLogItem } from "@opencode/client";
import { OpenCodeEvent as EventSchema } from "@opencode/protocol/groups/event";
import { PublicSessionMessage } from "@opencode/protocol/groups/message";
import { openCodeStackSafeEncodedSchema } from "./opencode-native-base64.js";
import { Form } from "@opencode/schema/form";
import { Location } from "@opencode/schema/location";
import { Permission } from "@opencode/schema/permission";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { Shell } from "@opencode/schema/shell";
import { Model } from "@opencode/schema/model";
import { PromptInput } from "@opencode/schema/prompt-input";
import { SessionMessage } from "@opencode/schema/session-message";
import { Skill } from "@opencode/schema/skill";
import { EventLog } from "@opencode/schema/event-log";
import { SessionEvent } from "@opencode/schema/session-event";
import { Schema } from "effect";
import path from "node:path";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { z } from "zod";
import { environmentVariableOverridesSchema } from "../../../shared/protocol/environment-variables.js";
import type { OpenCodeNativeFailure, OpenCodeReadMethod, OpenCodeReadInput, OpenCodeReadOutput,
  OpenCodeMutationMethod, OpenCodeMutationInput, OpenCodeMutationOutput, OpenCodeMutationControl } from "./opencode-native-port.js";

// These encoded native DTOs never cross the provider-private boundary.
export type OpenCodeNativeMessage = SessionMessageInfo;
export type OpenCodeNativeSession = SessionInfo;
export type OpenCodeNativeEvent = OpenCodeEvent;
export type OpenCodeNativeInboxItem = SessionInboxInfo;
export type OpenCodeNativeShell = ShellInfo1;
export interface OpenCodeNativeHistoryReadOptions {
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface OpenCodeNativeHistoryPage {
  readonly data: OpenCodeNativeMessage[];
  readonly cursor: { readonly previous?: string; readonly next?: string };
  readonly decodedBytes: number;
}
export interface OpenCodeNativeSessionListOptions extends OpenCodeNativeHistoryReadOptions {
  readonly directory?: string;
  readonly parentID?: string | null;
  readonly search?: string;
}
export interface OpenCodeNativeSessionPage {
  readonly data: OpenCodeNativeSession[];
  readonly cursor: { readonly previous?: string; readonly next?: string };
  readonly decodedBytes: number;
}
export interface OpenCodeNativeInteractions {
  readonly permissions: PermissionRequest[];
  readonly forms: FormInfo[];
}
export interface OpenCodeNativeActivity {
  readonly active: boolean;
  readonly children: OpenCodeNativeSession[];
  readonly activeChildren: string[];
  readonly shells: OpenCodeNativeShell[];
  readonly observedAt: number;
}
export class OpenCodeNativeReadLimitError extends OpenCodeRuntimeError {
  readonly retryable = false;
  constructor(readonly limit: "response_bytes" | "inventory_records") { super("opencode_native_read_limit"); }
}
export class OpenCodeNativeProtocolError extends OpenCodeRuntimeError {
  readonly retryable = false;
  constructor() { super("opencode_native_protocol_invalid"); }
}
export const OPENCODE_NATIVE_EVENT_BUFFER_RECORDS = 4_096;
export const OPENCODE_NATIVE_EVENT_BUFFER_BYTES = 32 * 1_024 * 1_024;
export const MAX_INVENTORY_RECORDS = 10_000;
export const NativeSession = Schema.Struct({ ...Session.Info.fields, location: Location.PublicRef });
export const NativeInboxMove = Schema.Struct({ ...SessionInbox.Move.fields,
  payload: Schema.Struct({ ...SessionInbox.MovePayload.fields, location: Location.PublicRef }) });
export const NativeInbox = Schema.Union([SessionInbox.User, SessionInbox.Synthetic, SessionInbox.Compaction, NativeInboxMove]);
export const Cursor = Schema.Struct({ previous: Schema.optional(Schema.String), next: Schema.optional(Schema.String) });
export const MessagePage = Schema.Struct({ data: Schema.Array(PublicSessionMessage), cursor: Cursor });
export const SessionPage = Schema.Struct({ data: Schema.Array(NativeSession), cursor: Cursor });
export const Active = Schema.Record(Session.ID, Schema.Struct({ type: Schema.Literal("running") }));
export const ShellList = Schema.Struct({ location: Location.PublicRef, data: Schema.Array(Shell.Info) });
export const Interrupt = Schema.Struct({ interrupted: Schema.Boolean });

export function openCodeNativeParser<T>(schema: Schema.Constraint, json = true): (value: unknown) => T {
  // Native HTTP endpoints use Effect's JSON codec, which emits null for some
  // optional values (notably page cursors). SSE directly JSON.stringifies events.
  const decode = Schema.decodeUnknownSync(openCodeStackSafeEncodedSchema(schema, json), { onExcessProperty: "error" });
  return value => {
    const limits = { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
      maximumTotalNodes: 1_000_000, maximumStringBytes: 32 * 1_024 * 1_024, maximumEncodedBytes: 32 * 1_024 * 1_024 };
    try { return snapshotBoundedJson(decode(snapshotBoundedJson(value, limits)), limits) as T; }
    catch { throw new OpenCodeNativeProtocolError(); }
  };
}
export const parser = openCodeNativeParser;
export const parseOpenCodeNativeMessage = parser<OpenCodeNativeMessage>(PublicSessionMessage);
export const parseOpenCodeNativeEvent = parser<OpenCodeNativeEvent>(EventSchema, false);
export const parseSession = parser<OpenCodeNativeSession>(NativeSession);
export const parseMessagePage = parser<SessionMessagesResponse>(MessagePage);
export const parseSessionPage = parser<SessionsResponse>(SessionPage);
export const parseActive = parser<Record<string, { type: "running" }>>(Active);
export const parseInbox = parser<OpenCodeNativeInboxItem[]>(Schema.Array(NativeInbox));
export const parsePermissions = parser<PermissionRequest[]>(Schema.Array(Permission.Request));
export const parseForms = parser<FormInfo[]>(Schema.Array(Form.Info));
export const parseShells = parser<{ location: { directory?: string }; data: OpenCodeNativeShell[] }>(ShellList);
export const parseInterrupt = parser<{ interrupted: boolean }>(Interrupt);

export function decodedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { throw new OpenCodeNativeProtocolError(); }
}
export function id(value: string, prefix: "ses_" | "msg_"): void {
  if (!value.startsWith(prefix) || value.length <= prefix.length || value.length > 256 || /[\x00-\x20/\\]/u.test(value)) {
    throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
  }
}
export function pageOptions(input: OpenCodeNativeHistoryReadOptions): { limit: number; cursor?: string; order?: "asc" | "desc" } {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      (input.order !== undefined && input.order !== "asc" && input.order !== "desc") ||
      (input.cursor !== undefined && (!input.cursor || input.cursor.length > 16_384 || input.order !== undefined))) {
    throw new OpenCodeRuntimeError("opencode_native_read_input_invalid");
  }
  return { limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : input.order !== undefined ? { order: input.order } : {}) };
}
export function boundedInventory<T>(values: T[]): T[] {
  if (values.length > MAX_INVENTORY_RECORDS) throw new OpenCodeNativeReadLimitError("inventory_records");
  return values;
}
export function pageCursor(cursor: { readonly previous?: string | null; readonly next?: string | null }): OpenCodeNativeHistoryPage["cursor"] {
  if ([cursor.previous, cursor.next].some(value => value != null && (!value || value.length > 16_384))) throw new OpenCodeNativeProtocolError();
  return { ...(cursor.previous != null ? { previous: cursor.previous } : {}), ...(cursor.next != null ? { next: cursor.next } : {}) };
}
export async function nativeRead<T>(effect: () => Promise<T>, sessionID?: string, messageID?: string): Promise<T> {
  try { return await effect(); }
  catch (error) {
    if (error && typeof error === "object" && "_tag" in error) {
      if (error._tag === "InvalidCursorError") throw new OpenCodeRuntimeError("opencode_native_cursor_invalid");
      if ("sessionID" in error && error.sessionID === sessionID &&
          (error._tag === "SessionNotFoundError" || (error._tag === "MessageNotFoundError" && "messageID" in error && error.messageID === messageID))) {
        throw new OpenCodeRuntimeError("opencode_native_not_found");
      }
    }
    throw error;
  }
}


export type OpenCodeNativeModel = ModelInfo;
export type OpenCodeNativeModelRef = ModelRef;
export type OpenCodeNativePromptAdmission = SessionInboxUser;
export type OpenCodeNativeCompactInput = Pick<SessionCompactInput, "sessionID"> & { readonly id: string; readonly delivery: "steer" | "queue" };
export type OpenCodeNativePermission = PermissionRequest;
export type OpenCodeNativeFormDetail = FormDetail;
export type OpenCodeNativeFormAnswer = SessionFormReplyInput["answer"];
export type OpenCodeNativeSkill = Schema.Schema.Type<typeof Skill.Info>;
export type OpenCodeNativeCreateInput = Pick<SessionCreateInput, "title" | "model" | "metadata" | "permissions"> &
  { readonly id: string; readonly location: { readonly directory: string } };
export type OpenCodeNativePromptInput = Pick<SessionPromptInput, "sessionID" | "text" | "files" | "metadata" | "skills"> &
  { readonly id: string; readonly delivery: "steer" | "queue"; readonly resume: boolean };
export type OpenCodeNativePermissionReplyInput = Omit<PermissionReplyInput, "decision" | "message"> &
  { readonly decision: "once" | "reject" };

/** This error is raised only by local validation before the HTTP operation. */
export class OpenCodeNativeMutationInputError extends OpenCodeRuntimeError {
  readonly delivery = "not_sent" as const;
  constructor() { super("opencode_native_mutation_input_invalid"); }
}

export const requestLimits = { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
  maximumTotalNodes: 1_000_000, maximumStringBytes: 128 * 1_024 * 1_024, maximumEncodedBytes: 128 * 1_024 * 1_024 };
export function requestParser<T>(schema: Schema.Constraint): (input: T) => T {
  const parse = Schema.decodeUnknownSync(Schema.toEncoded(Schema.toCodecJson(schema)), { onExcessProperty: "error" });
  return input => {
    try { return snapshotBoundedJson(parse(snapshotBoundedJson(input, requestLimits)), requestLimits) as T; }
    catch { throw new OpenCodeNativeMutationInputError(); }
  };
}
export function nativeId(value: string, prefix: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length || value.length > 256 || /[\x00-\x20/\\]/u.test(value)) {
    throw new OpenCodeNativeMutationInputError();
  }
}
export function directory(value: string): void {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.length > 4_096 || value.includes("\0")) throw new OpenCodeNativeMutationInputError();
}
export const parseCreateInput = requestParser<OpenCodeNativeCreateInput>(Schema.Struct({ id: Session.ID,
  title: Schema.optional(Schema.String), model: Schema.optional(Model.Ref), location: Schema.Struct({ directory: Schema.String }),
  metadata: Schema.optional(Session.Metadata), permissions: Schema.optional(Permission.Ruleset) }));
export const parsePromptInput = requestParser<OpenCodeNativePromptInput>(Schema.Struct({ sessionID: Session.ID, id: SessionMessage.ID,
  text: PromptInput.Prompt.fields.text, files: PromptInput.Prompt.fields.files, skills: PromptInput.Prompt.fields.skills,
  metadata: SessionInbox.UserPayload.fields.metadata, delivery: SessionInbox.Delivery, resume: Schema.Boolean }));
export const parseInputRef = requestParser<SessionInboxCancelInput>(Schema.Struct({ sessionID: Session.ID, inboxID: SessionMessage.ID }));
export const parseCompactInput = requestParser<OpenCodeNativeCompactInput>(Schema.Struct({ sessionID: Session.ID,
  id: SessionMessage.ID, delivery: SessionInbox.Delivery }));
export const parseCompaction = openCodeNativeParser<SessionCompactOutput>(SessionInbox.Compaction);
export const parseModelInput = requestParser<SessionSwitchModelInput>(Schema.Struct({ sessionID: Session.ID, model: Model.Ref }));
export const parsePermissionRef = requestParser<PermissionGetInput>(Schema.Struct({ sessionID: Session.ID, requestID: Permission.ID }));
export const parsePermissionReply = requestParser<OpenCodeNativePermissionReplyInput>(Schema.Struct({ sessionID: Session.ID,
  requestID: Permission.ID, decision: Schema.Literals(["once", "reject"]) }));
export const parseFormRef = requestParser<SessionFormGetInput>(Schema.Struct({ sessionID: Session.ID, formID: Form.ID }));
export const parseFormReply = requestParser<SessionFormReplyInput>(Schema.Struct({ sessionID: Session.ID, formID: Form.ID, answer: Form.Answer }));
export const parseMutationSession = openCodeNativeParser<OpenCodeNativeSession>(Schema.Struct({ ...Session.Info.fields, location: Location.PublicRef }));
export const parseAdmission = openCodeNativeParser<OpenCodeNativePromptAdmission>(SessionInbox.User);
export const parsePermission = openCodeNativeParser<OpenCodeNativePermission>(Permission.Request);
export const parseForm = openCodeNativeParser<OpenCodeNativeFormDetail>(Form.Detail);
export const parseModels = openCodeNativeParser<{ location: { directory?: string }; data: ModelInfo[] }>(Location.response(Schema.Array(Model.Info)));
export const parseDefault = openCodeNativeParser<{ location: { directory?: string }; data: ModelInfo | null }>(Location.response(Schema.UndefinedOr(Model.Info)));
export const parseSkills = openCodeNativeParser<{ location: { directory?: string }; data: OpenCodeNativeSkill[] }>(Location.response(Schema.Array(Skill.Info)));
export const parseEnvironment = requestParser<{ sessionID: string; variables: Readonly<Record<string, string>> }>(Schema.Struct({
  sessionID: Session.ID, variables: Schema.Record(Schema.String, Schema.String) }));
export const parsePermissionsInput = requestParser<{ sessionID: string; permissions: Permission.Ruleset }>(Schema.Struct({
  sessionID: Session.ID, permissions: Permission.Ruleset }));
export function noContent(value: unknown): void { if (value !== undefined) throw new OpenCodeNativeProtocolError(); }
export function scopedRef(input: { sessionID: string }, other: string, prefix: string): void {
  nativeId(input.sessionID, "ses_"); nativeId(other, prefix);
}


export type OpenCodeNativeDurableEvent = SessionEventDurable;
export interface OpenCodeNativeLogLimits { readonly decodedBytes: number; readonly records: number; readonly milliseconds: number; }
export const OPENCODE_NATIVE_LOG_LIMITS: OpenCodeNativeLogLimits = Object.freeze({ decodedBytes: 64 * 1_024 * 1_024,
  records: 100_000, milliseconds: 60_000 });
export interface OpenCodeNativeLogGap {
  /** Missing coordinates greater than after and less than or equal to through. */
  readonly after: number;
  readonly through: number;
}
export interface OpenCodeNativeLogCut {
  readonly sessionID: string;
  readonly after?: number;
  readonly watermark: number | undefined;
  readonly events: readonly OpenCodeNativeDurableEvent[];
  readonly sequenceGaps: readonly OpenCodeNativeLogGap[];
  readonly decodedBytes: number;
  /** Acquired frames, including the final synced marker. */
  readonly records: number;
}
export interface OpenCodeNativeLogReadInput {
  readonly sessionID: string;
  readonly after?: number;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly limits?: Partial<OpenCodeNativeLogLimits>;
}
export class OpenCodeNativeLogError extends OpenCodeRuntimeError {
  constructor(readonly reason: "input" | "bytes" | "records" | "time" | "cancelled" | "invalid" | "incomplete") {
    super(`opencode_native_log_${reason}`);
  }
}
export const parseLog = openCodeNativeParser<SessionLogItem>(Schema.Union([SessionEvent.Durable, EventLog.Synced]), false);


/** Serialized private contracts share these validators with the local dispatcher. */
export const OPENCODE_NATIVE_RESULT_BYTES = 32 * 1_024 * 1_024;
export const OPENCODE_NATIVE_LOG_RESULT_BYTES = 64 * 1_024 * 1_024;
const sessionIdSchema = z.string().min(5).max(256).regex(/^ses_[^\x00-\x20/\\]+$/u);
const messageIdSchema = z.string().min(5).max(256).regex(/^msg_[^\x00-\x20/\\]+$/u);
const directorySchema = z.string().min(1).max(4096).refine(value => path.posix.isAbsolute(value) && !value.includes("\0"));
const pagingShape = { cursor: z.string().min(1).max(16384).optional(), order: z.enum(["asc", "desc"]).optional(), limit: z.number().int().min(1).max(200).optional() };
const logLimitsSchema = z.strictObject({ decodedBytes: z.number().int().min(1).max(OPENCODE_NATIVE_LOG_LIMITS.decodedBytes).optional(),
  records: z.number().int().min(1).max(OPENCODE_NATIVE_LOG_LIMITS.records).optional(), milliseconds: z.number().int().min(1).max(OPENCODE_NATIVE_LOG_LIMITS.milliseconds).optional() });
const readInputSchemas = {
  getSession: z.strictObject({ sessionID: sessionIdSchema }),
  listSessions: z.strictObject({ ...pagingShape, directory: directorySchema.optional(), parentID: sessionIdSchema.nullable().optional(), search: z.string().max(4096).optional() }),
  getMessage: z.strictObject({ sessionID: sessionIdSchema, messageID: messageIdSchema }),
  getHistoryPage: z.strictObject({ sessionID: sessionIdSchema, ...pagingShape }),
  getActive: z.strictObject({}), getPending: z.strictObject({ sessionID: sessionIdSchema }),
  getInteractions: z.strictObject({ sessionID: sessionIdSchema }), getActivity: z.strictObject({ sessionID: sessionIdSchema, directory: directorySchema }),
  listSkills: z.strictObject({ directory: directorySchema }), listModels: z.strictObject({ directory: directorySchema }), getDefaultModel: z.strictObject({ directory: directorySchema }),
  getPermission: z.strictObject({ sessionID: sessionIdSchema, requestID: z.string().min(5).max(256).regex(/^per_[^\x00-\x20/\\]+$/u) }),
  getForm: z.strictObject({ sessionID: sessionIdSchema, formID: z.string().min(5).max(256).regex(/^frm_[^\x00-\x20/\\]+$/u) }),
  readLog: z.strictObject({ sessionID: sessionIdSchema, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), limits: logLimitsSchema.optional() }),
} satisfies Record<OpenCodeReadMethod, z.ZodType>;
export const openCodeReadMethods = Object.freeze(Object.keys(readInputSchemas) as OpenCodeReadMethod[]);
export function parseOpenCodeReadInput<K extends OpenCodeReadMethod>(method: K, value: unknown): OpenCodeReadInput<K> {
  try {
    if (!Object.hasOwn(readInputSchemas, method)) throw new Error();
    const parsed = readInputSchemas[method].parse(snapshotBoundedJson(value, requestLimits));
    if (method === "listSessions" || method === "getHistoryPage") {
      const page = parsed as OpenCodeNativeSessionListOptions;
      pageOptions(page);
      if (method === "listSessions" && page.cursor !== undefined &&
          (page.directory !== undefined || page.parentID !== undefined || page.search !== undefined)) throw new Error();
    }
    return parsed as OpenCodeReadInput<K>;
  } catch { if (method === "readLog") throw new OpenCodeNativeLogError("input"); throw new OpenCodeRuntimeError("opencode_native_read_input_invalid"); }
}

const identityPart = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
export const openCodeNativeAuthoritySchema = z.strictObject({ tenantId: identityPart, principalId: identityPart,
  executionEnvironmentId: identityPart, backendInstanceId: identityPart, runtimeId: identityPart, nativeGeneration: identityPart,
  directory: directorySchema, session: z.strictObject({ applicationThreadId: identityPart, nativeSessionID: sessionIdSchema,
    bindingFingerprint: identityPart }).optional() });
export const openCodeMutationControlSchema = z.strictObject({ identity: z.discriminatedUnion("origin", [
  z.strictObject({ origin: z.literal("application"), applicationOperationId: identityPart,
    operationKind: z.enum(["create", "submit", "steer", "action", "interaction", "interrupt"]), step: identityPart }),
  z.strictObject({ origin: z.literal("host"), operationId: identityPart, step: identityPart }),
]), deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export function parseOpenCodeMutationControl(value: unknown): OpenCodeMutationControl {
  try { return openCodeMutationControlSchema.parse(snapshotBoundedJson(value, requestLimits)); }
  catch { throw new OpenCodeNativeMutationInputError(); }
}
export const openCodeMutationMethods = Object.freeze([
  "createSession", "prompt", "compact", "cancelInput", "setModel", "renameSession", "setPermissions", "replyPermission",
  "replyForm", "cancelForm", "interruptSession", "installSessionEnvironment", "ensureMcpRegistration",
] satisfies OpenCodeMutationMethod[]);
export function parseOpenCodeMutationInput<K extends OpenCodeMutationMethod>(method: K, value: unknown): OpenCodeMutationInput<K> {
  try {
    value = snapshotBoundedJson(value, requestLimits);
    let result: unknown;
    switch (method) {
      case "createSession": { const input = parseCreateInput(value as OpenCodeNativeCreateInput); nativeId(input.id, "ses_"); directory(input.location.directory); result = input; break; }
      case "prompt": { const input = parsePromptInput(value as OpenCodeNativePromptInput); scopedRef(input, input.id, "msg_"); result = input; break; }
      case "compact": { const input = parseCompactInput(value as OpenCodeNativeCompactInput); scopedRef(input, input.id, "msg_"); result = input; break; }
      case "cancelInput": { const input = parseInputRef(value as SessionInboxCancelInput); scopedRef(input, input.inboxID, "msg_"); result = input; break; }
      case "setModel": { const input = parseModelInput(value as SessionSwitchModelInput); nativeId(input.sessionID, "ses_"); result = input; break; }
      case "renameSession": { const input = z.strictObject({ sessionID: sessionIdSchema, title: z.string().refine(text => !!text.trim() && Buffer.byteLength(text) <= 16384) }).parse(value); result = input; break; }
      case "setPermissions": { const input = parsePermissionsInput(value as { sessionID: string; permissions: Permission.Ruleset }); nativeId(input.sessionID, "ses_"); if (input.permissions.length > 1024) throw new Error(); result = input; break; }
      case "replyPermission": { const input = parsePermissionReply(value as OpenCodeNativePermissionReplyInput); scopedRef(input, input.requestID, "per_"); result = input; break; }
      case "replyForm": { const input = parseFormReply(value as SessionFormReplyInput); scopedRef(input, input.formID, "frm_"); result = input; break; }
      case "cancelForm": { const input = parseFormRef(value as SessionFormCancelInput); scopedRef(input, input.formID, "frm_"); result = input; break; }
      case "interruptSession": result = z.strictObject({ sessionID: sessionIdSchema }).parse(value); break;
      case "installSessionEnvironment": { const input = z.strictObject({ sessionID: sessionIdSchema, definitions: environmentVariableOverridesSchema,
        definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), cliAdmissionId: identityPart.nullable() }).parse(value);
        for (const entry of Object.values(input.definitions)) if (entry.kind === "secret" && entry.source.kind === "protected_file") directory(entry.source.path);
        result = input; break; }
      case "ensureMcpRegistration": result = z.strictObject({ directory: directorySchema, registrationAdmissionId: identityPart }).parse(value); break;
      default: throw new Error();
    }
    return result as OpenCodeMutationInput<K>;
  } catch { throw new OpenCodeNativeMutationInputError(); }
}

function boundedResult(value: unknown, bytes = OPENCODE_NATIVE_RESULT_BYTES): unknown {
  try { return snapshotBoundedJson(value, { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
    maximumTotalNodes: 1_000_000, maximumStringBytes: bytes, maximumEncodedBytes: bytes }); }
  catch { throw new OpenCodeNativeReadLimitError("response_bytes"); }
}
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.strictObject({ previous: z.string().min(1).max(16384).optional(), next: z.string().min(1).max(16384).optional() });
const resultPageSchema = z.strictObject({ data: z.array(z.unknown()).max(200), cursor: cursorSchema, decodedBytes: countSchema });
const modelResultParser = openCodeNativeParser<OpenCodeNativeModel>(Model.Info);
const skillResultParser = openCodeNativeParser<OpenCodeNativeSkill>(Skill.Info);
const logEventParser = openCodeNativeParser<OpenCodeNativeDurableEvent>(SessionEvent.Durable, false);
export function parseOpenCodeReadOutput<K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>, value: unknown): OpenCodeReadOutput<K> {
  const captured = boundedResult(value, method === "readLog" ? OPENCODE_NATIVE_LOG_RESULT_BYTES : OPENCODE_NATIVE_RESULT_BYTES);
  try {
    let result: unknown;
    switch (method) {
      case "getSession": { const session = parseSession(captured); if (session.id !== (input as { sessionID: string }).sessionID) throw new Error(); result = session; break; }
      case "listSessions": { const page = resultPageSchema.parse(captured); if (page.data.length > ((input as OpenCodeNativeSessionListOptions).limit ?? 50)) throw new Error(); result = { ...page, data: page.data.map(parseSession) }; break; }
      case "getMessage": { const message = parseOpenCodeNativeMessage(captured); if (message.id !== (input as { messageID: string }).messageID) throw new Error(); result = message; break; }
      case "getHistoryPage": { const page = resultPageSchema.parse(captured); const data = page.data.map(parseOpenCodeNativeMessage); if (data.length > ((input as OpenCodeNativeHistoryReadOptions).limit ?? 50) || new Set(data.map(item => item.id)).size !== data.length) throw new Error(); result = { ...page, data }; break; }
      case "getActive": { const active = parseActive(captured); boundedInventory(Object.keys(active)); result = active; break; }
      case "getPending": { const pending = boundedInventory(parseInbox(captured)); if (pending.some(item => item.sessionID !== (input as SessionRef).sessionID) || new Set(pending.map(item => item.id)).size !== pending.length) throw new Error(); result = pending; break; }
      case "getInteractions": { const parts = z.strictObject({ permissions: z.array(z.unknown()).max(MAX_INVENTORY_RECORDS), forms: z.array(z.unknown()).max(MAX_INVENTORY_RECORDS) }).parse(captured);
        const permissions = parts.permissions.map(parsePermission), forms = parts.forms.map(openCodeNativeParser<FormInfo>(Form.Info));
        if ([...permissions, ...forms].some(item => item.sessionID !== (input as SessionRef).sessionID)) throw new Error(); result = { permissions, forms }; break; }
      case "getActivity": { const parts = z.strictObject({ active: z.boolean(), children: z.array(z.unknown()).max(MAX_INVENTORY_RECORDS),
        activeChildren: z.array(sessionIdSchema).max(MAX_INVENTORY_RECORDS), shells: z.array(z.unknown()).max(MAX_INVENTORY_RECORDS), observedAt: countSchema }).parse(captured);
        const children = parts.children.map(parseSession), shells = parts.shells.map(openCodeNativeParser<OpenCodeNativeShell>(Shell.Info));
        if (children.some(child => child.parentID !== (input as SessionRef).sessionID) || shells.some(shell => shell.metadata.sessionID !== (input as SessionRef).sessionID) ||
            new Set(children.map(child => child.id)).size !== children.length || new Set(parts.activeChildren).size !== parts.activeChildren.length || parts.activeChildren.some(id => !children.some(child => child.id === id))) throw new Error();
        result = { ...parts, children, shells }; break; }
      case "listModels": { const models = z.array(z.unknown()).max(10_000).parse(captured).map(modelResultParser); if (new Set(models.map(model => JSON.stringify([model.providerID, model.id]))).size !== models.length) throw new Error(); result = models; break; }
      case "listSkills": { const skills = z.array(z.unknown()).max(4096).parse(captured).map(skillResultParser); if (new Set(skills.map(skill => skill.id)).size !== skills.length) throw new Error(); result = skills; break; }
      case "getDefaultModel": result = captured === null ? null : modelResultParser(captured); break;
      case "getPermission": { const permission = parsePermission(captured); const ref = input as OpenCodeReadInput<"getPermission">; if (permission.sessionID !== ref.sessionID || permission.id !== ref.requestID) throw new Error(); result = permission; break; }
      case "getForm": { const form = parseForm(captured); const ref = input as OpenCodeReadInput<"getForm">; if (form.sessionID !== ref.sessionID || form.id !== ref.formID) throw new Error(); result = form; break; }
      case "readLog": { const cut = z.strictObject({ sessionID: sessionIdSchema, after: countSchema.optional(), watermark: countSchema.nullable(),
        events: z.array(z.unknown()).max(OPENCODE_NATIVE_LOG_LIMITS.records), sequenceGaps: z.array(z.strictObject({ after: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), through: countSchema })).max(OPENCODE_NATIVE_LOG_LIMITS.records + 1),
        decodedBytes: countSchema.max(OPENCODE_NATIVE_LOG_LIMITS.decodedBytes), records: countSchema.max(OPENCODE_NATIVE_LOG_LIMITS.records) }).parse(captured);
        const ref = input as OpenCodeReadInput<"readLog">;
        if (cut.sessionID !== ref.sessionID || cut.after !== ref.after) throw new Error();
        let frontier = ref.after ?? -1; const ids = new Set<string>();
        const events = cut.events.map(logEventParser);
        const gaps: OpenCodeNativeLogGap[] = [];
        for (const event of events) { const seq = event.durable.seq; if (event.durable.aggregateID !== ref.sessionID || event.data.sessionID !== ref.sessionID || seq <= frontier || ids.has(event.id)) throw new Error();
          if (seq > frontier + 1) gaps.push({ after: frontier, through: seq - 1 }); frontier = seq; ids.add(event.id); }
        if (cut.watermark === null ? frontier !== -1 : cut.watermark < frontier) throw new Error();
        if (cut.watermark !== null && cut.watermark > frontier) gaps.push({ after: frontier, through: cut.watermark });
        if (JSON.stringify(gaps) !== JSON.stringify(cut.sequenceGaps) || cut.records !== events.length + 1) throw new Error();
        result = { ...cut, watermark: cut.watermark, events }; break; }
      default: throw new Error();
    }
    return result as OpenCodeReadOutput<K>;
  } catch (error) { if (error instanceof OpenCodeRuntimeError) throw error; throw new OpenCodeNativeProtocolError(); }
}
type SessionRef = { readonly sessionID: string };
export function parseOpenCodeMutationOutput<K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, value: unknown): OpenCodeMutationOutput<K> {
  const captured = boundedResult(value);
  try {
    let result: unknown;
    if (method === "createSession") { const session = parseSession(captured); const request = input as OpenCodeNativeCreateInput;
      if (session.id !== request.id || session.location.directory !== request.location.directory) throw new Error(); result = session;
    } else if (method === "prompt") { const admission = parseAdmission(captured); const request = input as OpenCodeNativePromptInput;
      if (admission.id !== request.id || admission.sessionID !== request.sessionID) throw new Error(); result = admission;
    } else if (method === "compact") { const admission = parseCompaction(captured); const request = input as OpenCodeNativeCompactInput;
      if (admission.id !== request.id || admission.sessionID !== request.sessionID || admission.delivery !== request.delivery) throw new Error(); result = admission;
    } else if (method === "interruptSession") result = parseInterrupt(captured);
    else if (openCodeMutationMethods.includes(method)) result = z.strictObject({ ok: z.literal(true) }).parse(captured);
    else throw new Error();
    return result as OpenCodeMutationOutput<K>;
  } catch (error) { if (error instanceof OpenCodeRuntimeError) throw error; throw new OpenCodeNativeProtocolError(); }
}

const nativeFailureCodes = [
  "opencode_native_mutation_input_invalid", "opencode_native_read_input_invalid", "opencode_native_protocol_invalid",
  "opencode_native_not_found", "opencode_native_cursor_invalid", "opencode_request_aborted", "opencode_request_failed",
  "opencode_response_too_large", "opencode_runtime_unavailable", "opencode_runtime_identity_changed", "opencode_request_authority_mismatch", "opencode_session_location_changed",
  "opencode_event_ready_timeout", "opencode_event_stream_failed", "opencode_event_overflow", "opencode_event_aborted", "opencode_event_closed",
  "opencode_event_disconnected", "opencode_event_malformed", "opencode_event_waiter_limit",
  "opencode_mutation_cancelled_before_admission", "opencode_mutation_deadline_invalid", "opencode_mutation_identity_conflict",
  "opencode_mutation_acknowledged", "opencode_mutation_admission_closed", "opencode_mutation_deadline_expired",
  "opencode_mutation_retention_full", "opencode_mutation_outcome_unknown", "opencode_mutation_pending", "opencode_mutation_owner_closed",
  "opencode_mutation_wait_cancelled",
] as const;
const failureCodeSchema = z.enum(nativeFailureCodes);
export const openCodeNativeFailureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mutation_refused"), delivery: z.literal("not_sent"), code: failureCodeSchema }),
  z.strictObject({ kind: z.literal("mutation_unknown"), delivery: z.literal("sent_outcome_unknown"), code: failureCodeSchema }),
  z.strictObject({ kind: z.literal("runtime"), code: failureCodeSchema }), z.strictObject({ kind: z.literal("protocol"), code: failureCodeSchema }),
  z.strictObject({ kind: z.literal("read_limit"), limit: z.enum(["response_bytes", "inventory_records"]) }),
  z.strictObject({ kind: z.literal("log"), reason: z.enum(["input", "bytes", "records", "time", "cancelled", "invalid", "incomplete"]) }),
]);
export class OpenCodeNativeMutationDeliveryError extends OpenCodeRuntimeError {
  constructor(readonly delivery: "not_sent" | "sent_outcome_unknown", code: string) { super(code); }
}
export function encodeOpenCodeNativeFailure(error: unknown, sent: boolean): OpenCodeNativeFailure {
  const supplied = error instanceof OpenCodeRuntimeError ? failureCodeSchema.safeParse(error.code) : undefined;
  const code = supplied?.success ? supplied.data : "opencode_request_failed";
  if (error instanceof OpenCodeNativeMutationInputError) return { kind: "mutation_refused", delivery: "not_sent", code: "opencode_native_mutation_input_invalid" };
  if (error instanceof OpenCodeNativeMutationDeliveryError) return error.delivery === "not_sent" ? { kind: "mutation_refused", delivery: error.delivery, code } : { kind: "mutation_unknown", delivery: error.delivery, code };
  if (sent) return { kind: "mutation_unknown", delivery: "sent_outcome_unknown", code };
  if (error instanceof OpenCodeNativeReadLimitError) return { kind: "read_limit", limit: error.limit };
  if (error instanceof OpenCodeNativeLogError) return { kind: "log", reason: error.reason };
  if (error instanceof OpenCodeNativeProtocolError) return { kind: "protocol", code: "opencode_native_protocol_invalid" };
  return { kind: "runtime", code };
}
export function decodeOpenCodeNativeFailure(value: OpenCodeNativeFailure): OpenCodeRuntimeError {
  let failure: z.infer<typeof openCodeNativeFailureSchema>;
  try { failure = openCodeNativeFailureSchema.parse(value); }
  catch { return new OpenCodeNativeProtocolError(); }
  switch (failure.kind) {
    case "mutation_refused": return failure.code === "opencode_native_mutation_input_invalid" ? new OpenCodeNativeMutationInputError() : new OpenCodeNativeMutationDeliveryError("not_sent", failure.code);
    case "mutation_unknown": return new OpenCodeNativeMutationDeliveryError("sent_outcome_unknown", failure.code);
    case "read_limit": return new OpenCodeNativeReadLimitError(failure.limit);
    case "log": return new OpenCodeNativeLogError(failure.reason);
    case "protocol": return new OpenCodeNativeProtocolError();
    case "runtime": return new OpenCodeRuntimeError(failure.code);
  }
}
