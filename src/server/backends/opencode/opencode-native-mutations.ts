import type { FormDetail, ModelInfo, ModelRef, PermissionGetInput, PermissionReplyInput, PermissionRequest,
  SessionCreateInput, SessionFormCancelInput, SessionFormGetInput, SessionFormReplyInput, SessionInboxCancelInput,
  SessionInboxUser, SessionPromptInput, SessionSwitchModelInput, SessionCompactInput, SessionCompactOutput } from "@opencode/client";
import { Form } from "@opencode/schema/form";
import { Location } from "@opencode/schema/location";
import { Model } from "@opencode/schema/model";
import { Permission } from "@opencode/schema/permission";
import { PromptInput } from "@opencode/schema/prompt-input";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";
import { Skill } from "@opencode/schema/skill";
import { Schema } from "effect";
import path from "node:path";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { OpenCodeNativeProtocolError, openCodeNativeParser, type OpenCodeNativeSession } from "./opencode-native-api.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

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
  constructor() { super("opencode_native_mutation_input_invalid"); }
}

const requestLimits = { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
  maximumTotalNodes: 1_000_000, maximumStringBytes: 128 * 1_024 * 1_024, maximumEncodedBytes: 128 * 1_024 * 1_024 };
function requestParser<T>(schema: Schema.Constraint): (input: T) => T {
  const parse = Schema.decodeUnknownSync(Schema.toEncoded(Schema.toCodecJson(schema)), { onExcessProperty: "error" });
  return input => {
    try { return snapshotBoundedJson(parse(snapshotBoundedJson(input, requestLimits)), requestLimits) as T; }
    catch { throw new OpenCodeNativeMutationInputError(); }
  };
}
function nativeId(value: string, prefix: string): void {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length || value.length > 256 || /[\x00-\x20/\\]/u.test(value)) {
    throw new OpenCodeNativeMutationInputError();
  }
}
function directory(value: string): void {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 4_096 || value.includes("\0")) throw new OpenCodeNativeMutationInputError();
}
const parseCreateInput = requestParser<OpenCodeNativeCreateInput>(Schema.Struct({ id: Session.ID,
  title: Schema.optional(Schema.String), model: Schema.optional(Model.Ref), location: Schema.Struct({ directory: Schema.String }),
  metadata: Schema.optional(Session.Metadata), permissions: Schema.optional(Permission.Ruleset) }));
const parsePromptInput = requestParser<OpenCodeNativePromptInput>(Schema.Struct({ sessionID: Session.ID, id: SessionMessage.ID,
  text: PromptInput.Prompt.fields.text, files: PromptInput.Prompt.fields.files, skills: PromptInput.Prompt.fields.skills,
  metadata: SessionInbox.UserPayload.fields.metadata, delivery: SessionInbox.Delivery, resume: Schema.Boolean }));
const parseInputRef = requestParser<SessionInboxCancelInput>(Schema.Struct({ sessionID: Session.ID, inboxID: SessionMessage.ID }));
const parseCompactInput = requestParser<OpenCodeNativeCompactInput>(Schema.Struct({ sessionID: Session.ID,
  id: SessionMessage.ID, delivery: SessionInbox.Delivery }));
const parseCompaction = openCodeNativeParser<SessionCompactOutput>(SessionInbox.Compaction);
const parseModelInput = requestParser<SessionSwitchModelInput>(Schema.Struct({ sessionID: Session.ID, model: Model.Ref }));
const parsePermissionRef = requestParser<PermissionGetInput>(Schema.Struct({ sessionID: Session.ID, requestID: Permission.ID }));
const parsePermissionReply = requestParser<OpenCodeNativePermissionReplyInput>(Schema.Struct({ sessionID: Session.ID,
  requestID: Permission.ID, decision: Schema.Literals(["once", "reject"]) }));
const parseFormRef = requestParser<SessionFormGetInput>(Schema.Struct({ sessionID: Session.ID, formID: Form.ID }));
const parseFormReply = requestParser<SessionFormReplyInput>(Schema.Struct({ sessionID: Session.ID, formID: Form.ID, answer: Form.Answer }));
const parseSession = openCodeNativeParser<OpenCodeNativeSession>(Schema.Struct({ ...Session.Info.fields, location: Location.PublicRef }));
const parseAdmission = openCodeNativeParser<OpenCodeNativePromptAdmission>(SessionInbox.User);
const parsePermission = openCodeNativeParser<OpenCodeNativePermission>(Permission.Request);
const parseForm = openCodeNativeParser<OpenCodeNativeFormDetail>(Form.Detail);
const parseModels = openCodeNativeParser<{ location: { directory?: string }; data: ModelInfo[] }>(Location.response(Schema.Array(Model.Info)));
const parseDefault = openCodeNativeParser<{ location: { directory?: string }; data: ModelInfo | null }>(Location.response(Schema.UndefinedOr(Model.Info)));
const parseSkills = openCodeNativeParser<{ location: { directory?: string }; data: OpenCodeNativeSkill[] }>(Location.response(Schema.Array(Skill.Info)));
const parseEnvironment = requestParser<{ sessionID: string; variables: Readonly<Record<string, string>> }>(Schema.Struct({
  sessionID: Session.ID, variables: Schema.Record(Schema.String, Schema.String) }));
const parsePermissions = requestParser<{ sessionID: string; permissions: Permission.Ruleset }>(Schema.Struct({
  sessionID: Session.ID, permissions: Permission.Ruleset }));
function noContent(value: unknown): void { if (value !== undefined) throw new OpenCodeNativeProtocolError(); }
function scopedRef(input: { sessionID: string }, other: string, prefix: string): void {
  nativeId(input.sessionID, "ses_"); nativeId(other, prefix);
}

/** Typed native effects only. Receipts, retry authority and operation recovery belong to the caller. */
export class OpenCodeNativeMutations {
  constructor(readonly client: OpenCodeHttpClient) {}

  async createSession(input: OpenCodeNativeCreateInput, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    const request = parseCreateInput(input); nativeId(request.id, "ses_"); directory(request.location.directory);
    return this.client.call((client, budget) => client.session.create(request, { signal: budget }), value => {
      const session = parseSession(value);
      if (session.id !== request.id || session.location.directory !== request.location.directory) throw new OpenCodeNativeProtocolError();
      return session;
    }, signal);
  }
  async prompt(input: OpenCodeNativePromptInput, signal?: AbortSignal): Promise<OpenCodeNativePromptAdmission> {
    const request = parsePromptInput(input); scopedRef(request, request.id, "msg_");
    return this.client.call((client, budget) => client.session.prompt(request, { signal: budget }), value => {
      const admission = parseAdmission(value);
      if (admission.id !== request.id || admission.sessionID !== request.sessionID) throw new OpenCodeNativeProtocolError();
      // Native hooks prepare text/files/metadata before admission. Byte equality
      // with the original request is deliberately not acceptance authority.
      return admission;
    }, signal);
  }
  async cancelInput(input: SessionInboxCancelInput, signal?: AbortSignal): Promise<void> {
    const request = parseInputRef(input); scopedRef(request, request.inboxID, "msg_");
    return this.client.call((client, budget) => client.session.inbox.cancel(request, { signal: budget }), noContent, signal);
  }
  async compact(input: OpenCodeNativeCompactInput, signal?: AbortSignal): Promise<SessionCompactOutput> {
    const request = parseCompactInput(input); scopedRef(request, request.id, "msg_");
    return this.client.call((client, budget) => client.session.compact(request, { signal: budget }), value => {
      const admission = parseCompaction(value);
      // Native coalesces another pending compaction. That never proves admission
      // of our reserved control, nor gives us authority over the other control.
      if (admission.id !== request.id || admission.sessionID !== request.sessionID || admission.delivery !== request.delivery) {
        throw new OpenCodeNativeProtocolError();
      }
      return admission;
    }, signal);
  }
  async setEnvironment(input: { sessionID: string; variables: Readonly<Record<string, string>> }, signal?: AbortSignal): Promise<void> {
    const request = parseEnvironment(input); nativeId(request.sessionID, "ses_");
    if (Object.keys(request.variables).length > 512 || Buffer.byteLength(JSON.stringify(request.variables)) > 1_048_576 ||
        Object.entries(request.variables).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.length > 256 || value.includes("\0") || Buffer.byteLength(value) > 65_536)) {
      throw new OpenCodeNativeMutationInputError();
    }
    return this.client.call((client, budget) => client.session.environment(request, { signal: budget }), noContent, signal);
  }
  async setPermissions(input: { sessionID: string; permissions: Permission.Ruleset }, signal?: AbortSignal): Promise<void> {
    const request = parsePermissions(input); nativeId(request.sessionID, "ses_");
    if (request.permissions.length > 1_024) throw new OpenCodeNativeMutationInputError();
    return this.client.call((client, budget) => client.session.update(request, { signal: budget }), noContent, signal);
  }
  async listSkills(workspace: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeSkill[]> {
    directory(workspace);
    return this.client.call((client, budget) => client.skill.list({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseSkills(value);
      if (result.location.directory !== workspace || result.data.length > 4_096 ||
          new Set(result.data.map(skill => skill.id)).size !== result.data.length) throw new OpenCodeNativeProtocolError();
      return result.data;
    }, signal);
  }
  async listModels(workspace: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeModel[]> {
    directory(workspace);
    return this.client.call((client, budget) => client.model.list({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseModels(value);
      if (result.location.directory !== workspace || result.data.length > 10_000 ||
          new Set(result.data.map(model => JSON.stringify([model.providerID, model.id]))).size !== result.data.length) throw new OpenCodeNativeProtocolError();
      return result.data;
    }, signal);
  }
  async getDefaultModel(workspace: string, signal?: AbortSignal): Promise<OpenCodeNativeModel | undefined> {
    directory(workspace);
    return this.client.call((client, budget) => client.model.default({ location: { directory: workspace } }, { signal: budget }), value => {
      const result = parseDefault(value);
      if (result.location.directory !== workspace) throw new OpenCodeNativeProtocolError();
      return result.data ?? undefined;
    }, signal);
  }
  async setModel(input: SessionSwitchModelInput, signal?: AbortSignal): Promise<void> {
    const request = parseModelInput(input); nativeId(request.sessionID, "ses_");
    return this.client.call((client, budget) => client.session.switchModel(request, { signal: budget }), noContent, signal);
  }
  async renameSession(sessionID: string, title: string, signal?: AbortSignal): Promise<void> {
    nativeId(sessionID, "ses_");
    // Empty title asks OpenCode to generate a title using a model.
    if (typeof title !== "string" || !title.trim() || Buffer.byteLength(title) > 16_384) throw new OpenCodeNativeMutationInputError();
    return this.client.call((client, budget) => client.session.update({ sessionID, title }, { signal: budget }), noContent, signal);
  }
  async getPermission(input: PermissionGetInput, signal?: AbortSignal): Promise<OpenCodeNativePermission> {
    const request = parsePermissionRef(input); scopedRef(request, request.requestID, "per_");
    return this.client.call((client, budget) => client.permission.get(request, { signal: budget }), value => {
      const permission = parsePermission(value);
      if (permission.sessionID !== request.sessionID || permission.id !== request.requestID) throw new OpenCodeNativeProtocolError();
      return permission;
    }, signal);
  }
  async replyPermission(input: OpenCodeNativePermissionReplyInput, signal?: AbortSignal): Promise<void> {
    const request = parsePermissionReply(input); scopedRef(request, request.requestID, "per_");
    return this.client.call((client, budget) => client.permission.reply(request, { signal: budget }), noContent, signal);
  }
  async getForm(input: SessionFormGetInput, signal?: AbortSignal): Promise<OpenCodeNativeFormDetail> {
    const request = parseFormRef(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.get(request, { signal: budget }), value => {
      const form = parseForm(value);
      if (form.sessionID !== request.sessionID || form.id !== request.formID) throw new OpenCodeNativeProtocolError();
      return form;
    }, signal);
  }
  async replyForm(input: SessionFormReplyInput, signal?: AbortSignal): Promise<void> {
    const request = parseFormReply(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.reply(request, { signal: budget }), noContent, signal);
  }
  async cancelForm(input: SessionFormCancelInput, signal?: AbortSignal): Promise<void> {
    const request = parseFormRef(input); scopedRef(request, request.formID, "frm_");
    return this.client.call((client, budget) => client.session.form.cancel(request, { signal: budget }), noContent, signal);
  }
}
