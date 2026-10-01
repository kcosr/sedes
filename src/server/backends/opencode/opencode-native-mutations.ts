import type { PermissionGetInput, SessionFormGetInput, SessionFormReplyInput, SessionFormCancelInput,
  SessionInboxCancelInput, SessionSwitchModelInput, SessionCompactOutput } from "@opencode/client";
import type { Permission } from "@opencode/schema/permission";
import type { OpenCodeNativePort, OpenCodeMutationControl } from "./opencode-native-port.js";
import type { OpenCodeNativeCreateInput, OpenCodeNativeSession, OpenCodeNativePromptInput, OpenCodeNativePromptAdmission,
  OpenCodeNativeCompactInput, OpenCodeNativeSkill, OpenCodeNativeModel, OpenCodeNativePermission,
  OpenCodeNativePermissionReplyInput, OpenCodeNativeFormDetail } from "./opencode-native-codecs.js";
export { OpenCodeNativeMutationInputError } from "./opencode-native-codecs.js";
export type { OpenCodeNativeCreateInput, OpenCodeNativePromptInput, OpenCodeNativePromptAdmission, OpenCodeNativeCompactInput,
  OpenCodeNativeSkill, OpenCodeNativeModel, OpenCodeNativeModelRef, OpenCodeNativePermission, OpenCodeNativePermissionReplyInput,
  OpenCodeNativeFormDetail, OpenCodeNativeFormAnswer } from "./opencode-native-codecs.js";

/** Every effect has an explicit immutable operation step; no local shortcut exists. */
export class OpenCodeNativeMutations {
  constructor(readonly client: OpenCodeNativePort) {}
  createSession(input: OpenCodeNativeCreateInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<OpenCodeNativeSession> {
    return this.client.mutate("createSession", input, control, { signal });
  }
  prompt(input: OpenCodeNativePromptInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<OpenCodeNativePromptAdmission> {
    return this.client.mutate("prompt", input, control, { signal });
  }
  async cancelInput(input: SessionInboxCancelInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("cancelInput", input, control, { signal });
  }
  compact(input: OpenCodeNativeCompactInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<SessionCompactOutput> {
    return this.client.mutate("compact", input, control, { signal });
  }
  async setPermissions(input: { sessionID: string; permissions: Permission.Ruleset }, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("setPermissions", input, control, { signal });
  }
  listSkills(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeSkill[]> {
    return this.client.read("listSkills", { directory }, { signal });
  }
  listModels(directory: string, signal?: AbortSignal): Promise<readonly OpenCodeNativeModel[]> {
    return this.client.read("listModels", { directory }, { signal });
  }
  async getDefaultModel(directory: string, signal?: AbortSignal): Promise<OpenCodeNativeModel | undefined> {
    return await this.client.read("getDefaultModel", { directory }, { signal }) ?? undefined;
  }
  async setModel(input: SessionSwitchModelInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("setModel", input, control, { signal });
  }
  async renameSession(sessionID: string, title: string, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("renameSession", { sessionID, title }, control, { signal });
  }
  getPermission(input: PermissionGetInput, signal?: AbortSignal): Promise<OpenCodeNativePermission> {
    return this.client.read("getPermission", input, { signal });
  }
  async replyPermission(input: OpenCodeNativePermissionReplyInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("replyPermission", input, control, { signal });
  }
  getForm(input: SessionFormGetInput, signal?: AbortSignal): Promise<OpenCodeNativeFormDetail> {
    return this.client.read("getForm", input, { signal });
  }
  async replyForm(input: SessionFormReplyInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("replyForm", input, control, { signal });
  }
  async cancelForm(input: SessionFormCancelInput, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<void> {
    await this.client.mutate("cancelForm", input, control, { signal });
  }
}
