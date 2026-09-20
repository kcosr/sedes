import {
  decodeAuthenticateRequest,
  decodeAuthenticateResponse,
  decodeCancelNotification,
  decodeCancelRequestNotification,
  decodeCloseSessionRequest,
  decodeCloseSessionResponse,
  decodeCreateTerminalRequest,
  decodeCreateTerminalResponse,
  decodeDeleteSessionRequest,
  decodeDeleteSessionResponse,
  decodeForkSessionRequest,
  decodeForkSessionResponse,
  decodeInitializeRequest,
  decodeInitializeResponse,
  decodeKillTerminalRequest,
  decodeKillTerminalResponse,
  decodeListSessionsRequest,
  decodeListSessionsResponse,
  decodeLoadSessionRequest,
  decodeLoadSessionResponse,
  decodeLogoutRequest,
  decodeLogoutResponse,
  decodeNewSessionRequest,
  decodeNewSessionResponse,
  decodePromptRequest,
  decodePromptResponse,
  decodeReadTextFileRequest,
  decodeReadTextFileResponse,
  decodeReleaseTerminalRequest,
  decodeReleaseTerminalResponse,
  decodeRequestPermissionRequest,
  decodeRequestPermissionResponse,
  decodeResumeSessionRequest,
  decodeResumeSessionResponse,
  decodeSessionNotification,
  decodeSetSessionConfigOptionRequest,
  decodeSetSessionConfigOptionResponse,
  decodeSetSessionModeRequest,
  decodeSetSessionModeResponse,
  decodeTerminalOutputRequest,
  decodeTerminalOutputResponse,
  decodeWaitForTerminalExitRequest,
  decodeWaitForTerminalExitResponse,
  decodeWriteTextFileRequest,
  decodeWriteTextFileResponse,
} from "./generated/1.3.0/projectors.js";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CancelRequestNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  validateAuthenticateRequest,
  validateAuthenticateResponse,
  validateCancelNotification,
  validateCancelRequestNotification,
  validateCloseSessionRequest,
  validateCloseSessionResponse,
  validateCreateTerminalRequest,
  validateCreateTerminalResponse,
  validateInitializeRequest,
  validateInitializeResponse,
  validateDeleteSessionRequest,
  validateDeleteSessionResponse,
  validateForkSessionRequest,
  validateForkSessionResponse,
  validateKillTerminalRequest,
  validateKillTerminalResponse,
  validateListSessionsRequest,
  validateListSessionsResponse,
  validateLoadSessionRequest,
  validateLoadSessionResponse,
  validateLogoutRequest,
  validateLogoutResponse,
  validateNewSessionRequest,
  validateNewSessionResponse,
  validatePromptRequest,
  validatePromptResponse,
  validateReadTextFileRequest,
  validateReadTextFileResponse,
  validateReleaseTerminalRequest,
  validateReleaseTerminalResponse,
  validateRequestPermissionRequest,
  validateRequestPermissionResponse,
  validateResumeSessionRequest,
  validateResumeSessionResponse,
  validateSessionNotification,
  validateSetSessionConfigOptionRequest,
  validateSetSessionConfigOptionResponse,
  validateSetSessionModeRequest,
  validateSetSessionModeResponse,
  validateTerminalOutputRequest,
  validateTerminalOutputResponse,
  validateWaitForTerminalExitRequest,
  validateWaitForTerminalExitResponse,
  validateWriteTextFileRequest,
  validateWriteTextFileResponse,
} from "./generated/1.3.0/validators.js";
import type { AcpValueValidator } from "./schema.js";

export interface AcpValueDecoder<T> {
  (value: unknown): T | undefined;
}

export const SEDES_ACP_SDK_VERSION = "1.3.0" as const;
export const SEDES_ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES = 256 * 1024;
export const SEDES_ACP_MAXIMUM_TEXT_FILE_LINES = 10_000;
export const SEDES_ACP_MAXIMUM_PATH_BYTES = 32 * 1024;
export const SEDES_ACP_MAXIMUM_LOOKUP_BYTES = 256;

export type AcpMethodDirection =
  "client_to_agent" | "agent_to_client" | "protocol";
export type AcpOperationClass = "read" | "mutation" | "control";
export type AcpMethodStability = "stable-v1" | "unstable-v1" | "extension";
export type AcpReservedV1Disposition =
  "implemented-stable" | "implemented-unstable" | "reserved-disabled";

export interface AcpReservedV1Route {
  readonly direction: AcpMethodDirection;
  readonly kind: "request" | "notification";
  readonly method: string;
  readonly disposition: AcpReservedV1Disposition;
}

export interface AcpRequestDescriptor<Request, Response> {
  readonly kind: "request";
  readonly method: string;
  readonly direction: AcpMethodDirection;
  readonly operation: AcpOperationClass;
  readonly stability: AcpMethodStability;
  readonly requiredProfile: string;
  readonly capabilityEvidence?: readonly string[];
  readonly validateRequest: AcpValueValidator<Request>;
  readonly validateResponse: AcpValueValidator<Response>;
  readonly decodeRequest: AcpValueDecoder<Request>;
  readonly decodeResponse: AcpValueDecoder<Response>;
  readonly validateResponseForRequest?: {
    bivarianceHack(response: Response, request: Request): boolean;
  }["bivarianceHack"];
  readonly validateResponseForCapabilities?: {
    bivarianceHack(
      response: Response,
      clientCapabilities: Readonly<ClientCapabilities>,
      agentCapabilities: Readonly<AgentCapabilities>,
    ): boolean;
  }["bivarianceHack"];
  readonly outboundCapability?: {
    bivarianceHack(
      capabilities: Readonly<AgentCapabilities>,
      request: Request,
      clientCapabilities: Readonly<ClientCapabilities>,
    ): boolean;
  }["bivarianceHack"];
  readonly outboundAuthMethodId?: {
    bivarianceHack(request: Request): string;
  }["bivarianceHack"];
  readonly reverseCapability?: {
    bivarianceHack(
      capabilities: Readonly<ClientCapabilities>,
      request: Request,
    ): boolean;
  }["bivarianceHack"];
}

export interface AcpNotificationDescriptor<Params> {
  readonly kind: "notification";
  readonly method: string;
  readonly direction: AcpMethodDirection;
  readonly operation: AcpOperationClass;
  readonly stability: AcpMethodStability;
  readonly requiredProfile: string;
  readonly capabilityEvidence?: readonly string[];
  readonly validateParams: AcpValueValidator<Params>;
  readonly decodeParams: AcpValueDecoder<Params>;
  readonly notificationOrderingKey?: {
    bivarianceHack(params: Params): string | undefined;
  }["bivarianceHack"];
  readonly outboundCapability?: {
    bivarianceHack(
      capabilities: Readonly<AgentCapabilities>,
      params: Params,
    ): boolean;
  }["bivarianceHack"];
  readonly reverseCapability?: {
    bivarianceHack(
      capabilities: Readonly<ClientCapabilities>,
      params: Params,
    ): boolean;
  }["bivarianceHack"];
}

export type AcpDescriptor =
  AcpRequestDescriptor<unknown, unknown> | AcpNotificationDescriptor<unknown>;

const descriptorBrands = new WeakSet<object>();

export function defineAcpExtensionRequest<Request, Response>(input: {
  readonly method: string;
  readonly direction: Exclude<AcpMethodDirection, "protocol">;
  readonly operation: AcpOperationClass;
  readonly requiredProfile: string;
  readonly validateRequest: AcpValueValidator<Request>;
  readonly validateResponse: AcpValueValidator<Response>;
  readonly decodeRequest: AcpValueDecoder<Request>;
  readonly decodeResponse: AcpValueDecoder<Response>;
  readonly validateResponseForRequest?: (
    response: Response,
    request: Request,
  ) => boolean;
  readonly validateResponseForCapabilities?: (
    response: Response,
    clientCapabilities: Readonly<ClientCapabilities>,
    agentCapabilities: Readonly<AgentCapabilities>,
  ) => boolean;
  readonly outboundCapability?: (
    capabilities: Readonly<AgentCapabilities>,
    request: Request,
    clientCapabilities: Readonly<ClientCapabilities>,
  ) => boolean;
  readonly outboundAuthMethodId?: (request: Request) => string;
  readonly reverseCapability?: (
    capabilities: Readonly<ClientCapabilities>,
    request: Request,
  ) => boolean;
}): AcpRequestDescriptor<Request, Response> {
  return requestDescriptor({ ...input, stability: "extension" });
}

export function defineAcpExtensionNotification<Params>(input: {
  readonly method: string;
  readonly direction: Exclude<AcpMethodDirection, "protocol">;
  readonly operation: AcpOperationClass;
  readonly requiredProfile: string;
  readonly validateParams: AcpValueValidator<Params>;
  readonly decodeParams: AcpValueDecoder<Params>;
  readonly notificationOrderingKey?: (params: Params) => string | undefined;
  readonly outboundCapability?: (
    capabilities: Readonly<AgentCapabilities>,
    params: Params,
  ) => boolean;
  readonly reverseCapability?: (
    capabilities: Readonly<ClientCapabilities>,
    params: Params,
  ) => boolean;
}): AcpNotificationDescriptor<Params> {
  return notificationDescriptor({ ...input, stability: "extension" });
}

export function isAcpDescriptor(value: AcpDescriptor): boolean {
  return descriptorBrands.has(value);
}

const CAPABILITY_EVIDENCE = Object.freeze({
  initialize: Object.freeze([
    "/$defs/AgentCapabilities/properties/positionEncoding",
    "/$defs/AuthCapabilities/properties/terminal",
    "/$defs/AuthMethod/anyOf/1/properties/type",
    "/$defs/ClientCapabilities/properties/auth",
    "/$defs/ClientCapabilities/properties/elicitation",
    "/$defs/ClientCapabilities/properties/fs",
    "/$defs/ClientCapabilities/properties/nes",
    "/$defs/ClientCapabilities/properties/plan",
    "/$defs/ClientCapabilities/properties/positionEncodings",
    "/$defs/ClientCapabilities/properties/terminal",
    "/$defs/FileSystemCapabilities/properties/readTextFile",
    "/$defs/FileSystemCapabilities/properties/writeTextFile",
    "/$defs/InitializeResponse/properties/authMethods",
  ]),
  authenticate: Object.freeze([
    "/$defs/AuthenticateRequest/properties/methodId",
    "/$defs/AuthMethodAgent/properties/id",
    "/$defs/AuthMethodEnvVar/properties/id",
    "/$defs/AuthMethodTerminal/properties/id",
    "/$defs/InitializeResponse/properties/authMethods",
  ]),
  logout: Object.freeze([
    "/$defs/AgentAuthCapabilities/properties/logout",
    "/$defs/AgentCapabilities/properties/auth",
  ]),
  sessionSetup: Object.freeze([
    "/$defs/AgentCapabilities/properties/mcpCapabilities",
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/McpCapabilities/properties/acp",
    "/$defs/McpCapabilities/properties/http",
    "/$defs/McpCapabilities/properties/sse",
    "/$defs/SessionCapabilities/properties/additionalDirectories",
  ]),
  booleanConfig: Object.freeze([
    "/$defs/ClientCapabilities/properties/session",
    "/$defs/ClientSessionCapabilities/properties/configOptions",
    "/$defs/SessionConfigOptionsCapabilities/properties/boolean",
  ]),
  load: Object.freeze(["/$defs/AgentCapabilities/properties/loadSession"]),
  list: Object.freeze([
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/ListSessionsResponse/properties/sessions",
    "/$defs/SessionCapabilities/properties/additionalDirectories",
    "/$defs/SessionCapabilities/properties/list",
    "/$defs/SessionInfo/properties/additionalDirectories",
  ]),
  delete: Object.freeze([
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/SessionCapabilities/properties/delete",
  ]),
  resume: Object.freeze([
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/SessionCapabilities/properties/resume",
  ]),
  close: Object.freeze([
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/SessionCapabilities/properties/close",
  ]),
  fork: Object.freeze([
    "/$defs/AgentCapabilities/properties/sessionCapabilities",
    "/$defs/SessionCapabilities/properties/fork",
  ]),
  prompt: Object.freeze([
    "/$defs/AgentCapabilities/properties/promptCapabilities",
    "/$defs/PromptCapabilities/properties/audio",
    "/$defs/PromptCapabilities/properties/embeddedContext",
    "/$defs/PromptCapabilities/properties/image",
    "/$defs/PromptRequest/properties/prompt",
  ]),
  readTextFile: Object.freeze([
    "/$defs/ClientCapabilities/properties/fs",
    "/$defs/FileSystemCapabilities/properties/readTextFile",
    "/$defs/ReadTextFileRequest/properties/path",
  ]),
  writeTextFile: Object.freeze([
    "/$defs/ClientCapabilities/properties/fs",
    "/$defs/FileSystemCapabilities/properties/writeTextFile",
    "/$defs/WriteTextFileRequest/properties/path",
  ]),
  terminal: Object.freeze(["/$defs/ClientCapabilities/properties/terminal"]),
  sessionUpdate: Object.freeze([
    "/$defs/ClientCapabilities/properties/plan",
    "/$defs/ClientCapabilities/properties/session",
    "/$defs/ClientSessionCapabilities/properties/configOptions",
    "/$defs/ConfigOptionUpdate/properties/configOptions",
    "/$defs/SessionConfigOptionsCapabilities/properties/boolean",
    "/$defs/SessionNotification/properties/update",
  ]),
});

export const ACP_AGENT_REQUESTS = Object.freeze({
  initialize: requestDescriptor<InitializeRequest, InitializeResponse>({
    method: AGENT_METHODS.initialize,
    direction: "client_to_agent",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.initialize,
    decodeRequest: decoder(decodeInitializeRequest),
    decodeResponse: decoder(decodeInitializeResponse),
    validateRequest: validateInitializeRequestSemantics,
    validateResponse: validateInitializeResponseSemantics,
    validateResponseForRequest: validateInitializeResponseForRequest,
    outboundCapability: () => true,
  }),
  authenticate: requestDescriptor<AuthenticateRequest, AuthenticateResponse>({
    method: AGENT_METHODS.authenticate,
    direction: "client_to_agent",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.authenticate,
    decodeRequest: decoder(decodeAuthenticateRequest),
    decodeResponse: decoder(decodeAuthenticateResponse),
    validateRequest: validateAuthenticateRequestSemantics,
    validateResponse: validateAuthenticateResponse,
    outboundCapability: () => true,
    outboundAuthMethodId: (request) => request.methodId,
  }),
  logout: requestDescriptor<LogoutRequest, LogoutResponse>({
    method: AGENT_METHODS.logout,
    direction: "client_to_agent",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.logout,
    decodeRequest: decoder(decodeLogoutRequest),
    decodeResponse: decoder(decodeLogoutResponse),
    validateRequest: validateLogoutRequestSemantics,
    validateResponse: validateLogoutResponse,
    outboundCapability: (capabilities) => capabilities.auth?.logout != null,
  }),
  newSession: requestDescriptor<NewSessionRequest, NewSessionResponse>({
    method: AGENT_METHODS.session_new,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(
      CAPABILITY_EVIDENCE.sessionSetup,
      CAPABILITY_EVIDENCE.booleanConfig,
      [
        "/$defs/NewSessionRequest/properties/additionalDirectories",
        "/$defs/NewSessionRequest/properties/mcpServers",
        "/$defs/NewSessionResponse/properties/configOptions",
      ],
    ),
    decodeRequest: decoder(decodeNewSessionRequest),
    decodeResponse: decoder(decodeNewSessionResponse),
    validateRequest: validateNewSessionRequestSemantics,
    validateResponse: validateNewSessionResponseSemantics,
    validateResponseForCapabilities: (response, client) =>
      supportsBooleanConfigCatalog(client, response.configOptions),
    outboundCapability: supportsSessionSetup,
  }),
  loadSession: requestDescriptor<LoadSessionRequest, LoadSessionResponse>({
    method: AGENT_METHODS.session_load,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(
      CAPABILITY_EVIDENCE.load,
      CAPABILITY_EVIDENCE.sessionSetup,
      CAPABILITY_EVIDENCE.booleanConfig,
      [
        "/$defs/LoadSessionRequest/properties/additionalDirectories",
        "/$defs/LoadSessionRequest/properties/mcpServers",
        "/$defs/LoadSessionResponse/properties/configOptions",
      ],
    ),
    decodeRequest: decoder(decodeLoadSessionRequest),
    decodeResponse: decoder(decodeLoadSessionResponse),
    validateRequest: validateLoadSessionRequestSemantics,
    validateResponse: validateLoadSessionResponseSemantics,
    validateResponseForCapabilities: (response, client) =>
      supportsBooleanConfigCatalog(client, response.configOptions),
    outboundCapability: (capabilities, request) =>
      capabilities.loadSession === true &&
      supportsSessionSetup(capabilities, request),
  }),
  listSessions: requestDescriptor<ListSessionsRequest, ListSessionsResponse>({
    method: AGENT_METHODS.session_list,
    direction: "client_to_agent",
    operation: "read",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.list,
    decodeRequest: decoder(decodeListSessionsRequest),
    decodeResponse: decoder(decodeListSessionsResponse),
    validateRequest: validateListSessionsRequestSemantics,
    validateResponse: validateListSessionsResponseSemantics,
    validateResponseForRequest: (response, request) =>
      request.cwd == null ||
      response.sessions.every((session) => session.cwd === request.cwd),
    validateResponseForCapabilities: (response, _client, agent) =>
      agent.sessionCapabilities?.additionalDirectories != null ||
      response.sessions.every(
        (session) => session.additionalDirectories == null,
      ),
    outboundCapability: (capabilities) =>
      capabilities.sessionCapabilities?.list != null,
  }),
  deleteSession: requestDescriptor<DeleteSessionRequest, DeleteSessionResponse>(
    {
      method: AGENT_METHODS.session_delete,
      direction: "client_to_agent",
      operation: "mutation",
      stability: "stable-v1",
      requiredProfile: "acp-v1",
      capabilityEvidence: CAPABILITY_EVIDENCE.delete,
      decodeRequest: decoder(decodeDeleteSessionRequest),
      decodeResponse: decoder(decodeDeleteSessionResponse),
      validateRequest: validateSessionIdRequest(validateDeleteSessionRequest),
      validateResponse: validateDeleteSessionResponse,
      outboundCapability: (capabilities) =>
        capabilities.sessionCapabilities?.delete != null,
    },
  ),
  resumeSession: requestDescriptor<ResumeSessionRequest, ResumeSessionResponse>(
    {
      method: AGENT_METHODS.session_resume,
      direction: "client_to_agent",
      operation: "mutation",
      stability: "stable-v1",
      requiredProfile: "acp-v1",
      capabilityEvidence: capabilityEvidence(
        CAPABILITY_EVIDENCE.resume,
        CAPABILITY_EVIDENCE.sessionSetup,
        CAPABILITY_EVIDENCE.booleanConfig,
        [
          "/$defs/ResumeSessionRequest/properties/additionalDirectories",
          "/$defs/ResumeSessionRequest/properties/mcpServers",
          "/$defs/ResumeSessionResponse/properties/configOptions",
        ],
      ),
      decodeRequest: decoder(decodeResumeSessionRequest),
      decodeResponse: decoder(decodeResumeSessionResponse),
      validateRequest: validateResumeSessionRequestSemantics,
      validateResponse: validateResumeSessionResponseSemantics,
      validateResponseForCapabilities: (response, client) =>
        supportsBooleanConfigCatalog(client, response.configOptions),
      outboundCapability: (capabilities, request) =>
        capabilities.sessionCapabilities?.resume != null &&
        supportsSessionSetup(capabilities, request),
    },
  ),
  closeSession: requestDescriptor<CloseSessionRequest, CloseSessionResponse>({
    method: AGENT_METHODS.session_close,
    direction: "client_to_agent",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.close,
    decodeRequest: decoder(decodeCloseSessionRequest),
    decodeResponse: decoder(decodeCloseSessionResponse),
    validateRequest: validateSessionIdRequest(validateCloseSessionRequest),
    validateResponse: validateCloseSessionResponse,
    outboundCapability: (capabilities) =>
      capabilities.sessionCapabilities?.close != null,
  }),
  setSessionMode: requestDescriptor<
    SetSessionModeRequest,
    SetSessionModeResponse
  >({
    method: AGENT_METHODS.session_set_mode,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    decodeRequest: decoder(decodeSetSessionModeRequest),
    decodeResponse: decoder(decodeSetSessionModeResponse),
    validateRequest: validateSetSessionModeRequestSemantics,
    validateResponse: validateSetSessionModeResponse,
    outboundCapability: () => true,
  }),
  setSessionConfigOption: requestDescriptor<
    SetSessionConfigOptionRequest,
    SetSessionConfigOptionResponse
  >({
    method: AGENT_METHODS.session_set_config_option,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.booleanConfig, [
      "/$defs/SetSessionConfigOptionRequest/anyOf/0/properties/value",
      "/$defs/SetSessionConfigOptionRequest/anyOf/1/properties/value",
      "/$defs/SetSessionConfigOptionResponse/properties/configOptions",
    ]),
    decodeRequest: decoder(decodeSetSessionConfigOptionRequest),
    decodeResponse: decoder(decodeSetSessionConfigOptionResponse),
    validateRequest: validateSetSessionConfigOptionRequestSemantics,
    validateResponse: validateSetSessionConfigOptionResponseSemantics,
    validateResponseForRequest:
      validateSetSessionConfigOptionResponseForRequest,
    validateResponseForCapabilities: (response, client) =>
      supportsBooleanConfigCatalog(client, response.configOptions),
    outboundCapability: (_agent, request, client) =>
      typeof request.value !== "boolean" || supportsBooleanConfig(client),
  }),
  prompt: requestDescriptor<PromptRequest, PromptResponse>({
    method: AGENT_METHODS.session_prompt,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.prompt,
    decodeRequest: decoder(decodePromptRequest),
    decodeResponse: decoder(decodePromptResponse),
    validateRequest: validatePromptRequestSemantics,
    validateResponse: validatePromptResponseSemantics,
    outboundCapability: supportsPrompt,
  }),
});

export const ACP_UNSTABLE_V1_AGENT_REQUESTS = Object.freeze({
  forkSession: requestDescriptor<ForkSessionRequest, ForkSessionResponse>({
    method: AGENT_METHODS.session_fork,
    direction: "client_to_agent",
    operation: "mutation",
    stability: "unstable-v1",
    requiredProfile: "acp-v1-unstable",
    capabilityEvidence: capabilityEvidence(
      CAPABILITY_EVIDENCE.fork,
      CAPABILITY_EVIDENCE.sessionSetup,
      CAPABILITY_EVIDENCE.booleanConfig,
      [
        "/$defs/ForkSessionRequest/properties/additionalDirectories",
        "/$defs/ForkSessionRequest/properties/mcpServers",
        "/$defs/ForkSessionResponse/properties/configOptions",
      ],
    ),
    decodeRequest: decoder(decodeForkSessionRequest),
    decodeResponse: decoder(decodeForkSessionResponse),
    validateRequest: validateForkSessionRequestSemantics,
    validateResponse: validateForkSessionResponseSemantics,
    validateResponseForCapabilities: (response, client) =>
      supportsBooleanConfigCatalog(client, response.configOptions),
    outboundCapability: (capabilities, request) =>
      capabilities.sessionCapabilities?.fork != null &&
      supportsSessionSetup(capabilities, request),
  }),
});

export const ACP_AGENT_NOTIFICATIONS = Object.freeze({
  cancelSession: notificationDescriptor<CancelNotification>({
    method: AGENT_METHODS.session_cancel,
    direction: "client_to_agent",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    decodeParams: decoder(decodeCancelNotification),
    validateParams: validateSessionIdRequest(validateCancelNotification),
    outboundCapability: () => true,
    notificationOrderingKey: (params) => params.sessionId,
  }),
});

export const ACP_CLIENT_REQUESTS = Object.freeze({
  requestPermission: requestDescriptor<
    RequestPermissionRequest,
    RequestPermissionResponse
  >({
    method: CLIENT_METHODS.session_request_permission,
    direction: "agent_to_client",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    decodeRequest: decoder(decodeRequestPermissionRequest),
    decodeResponse: decoder(decodeRequestPermissionResponse),
    validateRequest: validateRequestPermissionRequestSemantics,
    validateResponse: validateRequestPermissionResponseSemantics,
    validateResponseForRequest: (response, request) => {
      const outcome = response.outcome;
      return (
        outcome.outcome === "cancelled" ||
        request.options.some((option) => option.optionId === outcome.optionId)
      );
    },
    reverseCapability: () => true,
  }),
  readTextFile: requestDescriptor<ReadTextFileRequest, ReadTextFileResponse>({
    method: CLIENT_METHODS.fs_read_text_file,
    direction: "agent_to_client",
    operation: "read",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.readTextFile,
    decodeRequest: decoder(decodeReadTextFileRequest),
    decodeResponse: decoder(decodeReadTextFileResponse),
    validateRequest: validateReadTextFileRequestSemantics,
    validateResponse: validateReadTextFileResponse,
    reverseCapability: (capabilities) => capabilities.fs?.readTextFile === true,
  }),
  writeTextFile: requestDescriptor<WriteTextFileRequest, WriteTextFileResponse>(
    {
      method: CLIENT_METHODS.fs_write_text_file,
      direction: "agent_to_client",
      operation: "mutation",
      stability: "stable-v1",
      requiredProfile: "acp-v1",
      capabilityEvidence: CAPABILITY_EVIDENCE.writeTextFile,
      decodeRequest: decoder(decodeWriteTextFileRequest),
      decodeResponse: decoder(decodeWriteTextFileResponse),
      validateRequest: validateWriteTextFileRequestSemantics,
      validateResponse: validateWriteTextFileResponse,
      reverseCapability: (capabilities) =>
        capabilities.fs?.writeTextFile === true,
    },
  ),
  createTerminal: requestDescriptor<
    CreateTerminalRequest,
    CreateTerminalResponse
  >({
    method: CLIENT_METHODS.terminal_create,
    direction: "agent_to_client",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.terminal, [
      "/$defs/CreateTerminalRequest/properties/command",
      "/$defs/CreateTerminalRequest/properties/cwd",
      "/$defs/CreateTerminalRequest/properties/outputByteLimit",
    ]),
    decodeRequest: decoder(decodeCreateTerminalRequest),
    decodeResponse: decoder(decodeCreateTerminalResponse),
    validateRequest: validateCreateTerminalRequestSemantics,
    validateResponse: validateCreateTerminalResponseSemantics,
    reverseCapability: terminalCapability,
  }),
  terminalOutput: requestDescriptor<
    TerminalOutputRequest,
    TerminalOutputResponse
  >({
    method: CLIENT_METHODS.terminal_output,
    direction: "agent_to_client",
    operation: "read",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.terminal, [
      "/$defs/TerminalOutputRequest/properties/terminalId",
    ]),
    decodeRequest: decoder(decodeTerminalOutputRequest),
    decodeResponse: decoder(decodeTerminalOutputResponse),
    validateRequest: validateTerminalIdRequest(validateTerminalOutputRequest),
    validateResponse: validateTerminalOutputResponseSemantics,
    reverseCapability: terminalCapability,
  }),
  releaseTerminal: requestDescriptor<
    ReleaseTerminalRequest,
    ReleaseTerminalResponse
  >({
    method: CLIENT_METHODS.terminal_release,
    direction: "agent_to_client",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.terminal, [
      "/$defs/ReleaseTerminalRequest/properties/terminalId",
    ]),
    decodeRequest: decoder(decodeReleaseTerminalRequest),
    decodeResponse: decoder(decodeReleaseTerminalResponse),
    validateRequest: validateTerminalIdRequest(validateReleaseTerminalRequest),
    validateResponse: validateReleaseTerminalResponse,
    reverseCapability: terminalCapability,
  }),
  waitForTerminalExit: requestDescriptor<
    WaitForTerminalExitRequest,
    WaitForTerminalExitResponse
  >({
    method: CLIENT_METHODS.terminal_wait_for_exit,
    direction: "agent_to_client",
    operation: "read",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.terminal, [
      "/$defs/WaitForTerminalExitRequest/properties/terminalId",
    ]),
    decodeRequest: decoder(decodeWaitForTerminalExitRequest),
    decodeResponse: decoder(decodeWaitForTerminalExitResponse),
    validateRequest: validateTerminalIdRequest(
      validateWaitForTerminalExitRequest,
    ),
    validateResponse: validateWaitForTerminalExitResponseSemantics,
    reverseCapability: terminalCapability,
  }),
  killTerminal: requestDescriptor<KillTerminalRequest, KillTerminalResponse>({
    method: CLIENT_METHODS.terminal_kill,
    direction: "agent_to_client",
    operation: "mutation",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: capabilityEvidence(CAPABILITY_EVIDENCE.terminal, [
      "/$defs/KillTerminalRequest/properties/terminalId",
    ]),
    decodeRequest: decoder(decodeKillTerminalRequest),
    decodeResponse: decoder(decodeKillTerminalResponse),
    validateRequest: validateTerminalIdRequest(validateKillTerminalRequest),
    validateResponse: validateKillTerminalResponse,
    reverseCapability: terminalCapability,
  }),
});

export const ACP_CLIENT_NOTIFICATIONS = Object.freeze({
  sessionUpdate: notificationDescriptor<SessionNotification>({
    method: CLIENT_METHODS.session_update,
    direction: "agent_to_client",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    capabilityEvidence: CAPABILITY_EVIDENCE.sessionUpdate,
    decodeParams: decoder(decodeSessionNotification),
    validateParams: validateSessionNotificationSemantics,
    notificationOrderingKey: (params) => params.sessionId,
    reverseCapability: (capabilities, params) => {
      const update = params.update as { readonly sessionUpdate?: string };
      if (
        (update.sessionUpdate === "plan_update" ||
          update.sessionUpdate === "plan_removed") &&
        capabilities.plan == null
      ) {
        return false;
      }
      if (
        update.sessionUpdate === "config_option_update" &&
        !supportsBooleanConfigCatalog(
          capabilities,
          (params.update as { readonly configOptions?: unknown }).configOptions,
        )
      ) {
        return false;
      }
      return true;
    },
  }),
});

export const ACP_PROTOCOL_NOTIFICATIONS = Object.freeze({
  cancelRequest: notificationDescriptor<CancelRequestNotification>({
    method: PROTOCOL_METHODS.cancel_request,
    direction: "protocol",
    operation: "control",
    stability: "stable-v1",
    requiredProfile: "acp-v1",
    decodeParams: decoder(decodeCancelRequestNotification),
    validateParams: validateCancelRequestNotification,
  }),
});

/**
 * Every method identity published by the pinned stable SDK root. Disabled
 * unstable methods remain reserved so an extension cannot silently redefine
 * a standard ACP route.
 */
export const ACP_RESERVED_V1_ROUTES = Object.freeze([
  ...reservedRoutes("client_to_agent", "request", "implemented-stable", [
    AGENT_METHODS.initialize,
    AGENT_METHODS.authenticate,
    AGENT_METHODS.logout,
    AGENT_METHODS.session_new,
    AGENT_METHODS.session_load,
    AGENT_METHODS.session_list,
    AGENT_METHODS.session_delete,
    AGENT_METHODS.session_resume,
    AGENT_METHODS.session_close,
    AGENT_METHODS.session_set_mode,
    AGENT_METHODS.session_set_config_option,
    AGENT_METHODS.session_prompt,
  ]),
  ...reservedRoutes("client_to_agent", "notification", "implemented-stable", [
    AGENT_METHODS.session_cancel,
  ]),
  ...reservedRoutes("client_to_agent", "request", "implemented-unstable", [
    AGENT_METHODS.session_fork,
  ]),
  ...reservedRoutes("agent_to_client", "request", "implemented-stable", [
    CLIENT_METHODS.session_request_permission,
    CLIENT_METHODS.fs_write_text_file,
    CLIENT_METHODS.fs_read_text_file,
    CLIENT_METHODS.terminal_create,
    CLIENT_METHODS.terminal_output,
    CLIENT_METHODS.terminal_release,
    CLIENT_METHODS.terminal_wait_for_exit,
    CLIENT_METHODS.terminal_kill,
  ]),
  ...reservedRoutes("agent_to_client", "notification", "implemented-stable", [
    CLIENT_METHODS.session_update,
  ]),
  ...reservedRoutes("protocol", "notification", "implemented-stable", [
    PROTOCOL_METHODS.cancel_request,
  ]),
  ...reservedRoutes("client_to_agent", "request", "reserved-disabled", [
    AGENT_METHODS.providers_list,
    AGENT_METHODS.providers_set,
    AGENT_METHODS.providers_disable,
    AGENT_METHODS.nes_start,
    AGENT_METHODS.nes_suggest,
    AGENT_METHODS.nes_close,
    AGENT_METHODS.mcp_message,
  ]),
  ...reservedRoutes("client_to_agent", "notification", "reserved-disabled", [
    AGENT_METHODS.nes_accept,
    AGENT_METHODS.nes_reject,
    AGENT_METHODS.document_did_open,
    AGENT_METHODS.document_did_change,
    AGENT_METHODS.document_did_close,
    AGENT_METHODS.document_did_save,
    AGENT_METHODS.document_did_focus,
    AGENT_METHODS.mcp_message,
  ]),
  ...reservedRoutes("agent_to_client", "request", "reserved-disabled", [
    CLIENT_METHODS.mcp_connect,
    CLIENT_METHODS.mcp_message,
    CLIENT_METHODS.mcp_disconnect,
    CLIENT_METHODS.elicitation_create,
  ]),
  ...reservedRoutes("agent_to_client", "notification", "reserved-disabled", [
    CLIENT_METHODS.mcp_message,
    CLIENT_METHODS.elicitation_complete,
  ]),
] as const);

export const ACP_STABLE_V1_AGENT_DESCRIPTORS = Object.freeze([
  ...Object.values(ACP_AGENT_REQUESTS),
  ...Object.values(ACP_AGENT_NOTIFICATIONS),
] as const);

export const ACP_UNSTABLE_V1_AGENT_DESCRIPTORS = Object.freeze([
  ...Object.values(ACP_UNSTABLE_V1_AGENT_REQUESTS),
] as const);

export const ACP_STABLE_V1_REVERSE_DESCRIPTORS = Object.freeze([
  ...Object.values(ACP_CLIENT_REQUESTS),
  ...Object.values(ACP_CLIENT_NOTIFICATIONS),
] as const);

function requestDescriptor<Request, Response>(input: {
  readonly method: string;
  readonly direction: AcpMethodDirection;
  readonly operation: AcpOperationClass;
  readonly stability: AcpMethodStability;
  readonly requiredProfile: string;
  readonly capabilityEvidence?: readonly string[];
  readonly validateRequest: AcpValueValidator<Request>;
  readonly validateResponse: AcpValueValidator<Response>;
  readonly decodeRequest: AcpValueDecoder<Request>;
  readonly decodeResponse: AcpValueDecoder<Response>;
  readonly validateResponseForRequest?: (
    response: Response,
    request: Request,
  ) => boolean;
  readonly validateResponseForCapabilities?: (
    response: Response,
    clientCapabilities: Readonly<ClientCapabilities>,
    agentCapabilities: Readonly<AgentCapabilities>,
  ) => boolean;
  readonly outboundCapability?: (
    capabilities: Readonly<AgentCapabilities>,
    request: Request,
    clientCapabilities: Readonly<ClientCapabilities>,
  ) => boolean;
  readonly outboundAuthMethodId?: (request: Request) => string;
  readonly reverseCapability?: (
    capabilities: Readonly<ClientCapabilities>,
    request: Request,
  ) => boolean;
}): AcpRequestDescriptor<Request, Response> {
  validateDescriptorInput(input.method, input.requiredProfile);
  if (
    typeof input.decodeRequest !== "function" ||
    typeof input.decodeResponse !== "function" ||
    typeof input.validateRequest !== "function" ||
    typeof input.validateResponse !== "function"
  ) {
    throw new Error("acp_descriptor_invalid");
  }
  const descriptor = Object.freeze({
    kind: "request" as const,
    ...input,
  });
  descriptorBrands.add(descriptor);
  return descriptor;
}

function notificationDescriptor<Params>(input: {
  readonly method: string;
  readonly direction: AcpMethodDirection;
  readonly operation: AcpOperationClass;
  readonly stability: AcpMethodStability;
  readonly requiredProfile: string;
  readonly capabilityEvidence?: readonly string[];
  readonly validateParams: AcpValueValidator<Params>;
  readonly decodeParams: AcpValueDecoder<Params>;
  readonly notificationOrderingKey?: (params: Params) => string | undefined;
  readonly outboundCapability?: (
    capabilities: Readonly<AgentCapabilities>,
    params: Params,
  ) => boolean;
  readonly reverseCapability?: (
    capabilities: Readonly<ClientCapabilities>,
    params: Params,
  ) => boolean;
}): AcpNotificationDescriptor<Params> {
  validateDescriptorInput(input.method, input.requiredProfile);
  if (
    typeof input.decodeParams !== "function" ||
    typeof input.validateParams !== "function"
  ) {
    throw new Error("acp_descriptor_invalid");
  }
  const descriptor = Object.freeze({
    kind: "notification" as const,
    ...input,
  });
  descriptorBrands.add(descriptor);
  return descriptor;
}

function capabilityEvidence(
  ...groups: readonly (readonly string[])[]
): readonly string[] {
  return Object.freeze([...new Set(groups.flat())].sort());
}

function decoder<T>(
  generated: (value: unknown) => unknown | undefined,
): AcpValueDecoder<T> {
  return generated as AcpValueDecoder<T>;
}

function validateDescriptorInput(method: string, profile: string): void {
  if (
    !/^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/u.test(method) ||
    method.startsWith("rpc.") ||
    method.length > 128 ||
    profile.length === 0 ||
    profile.length > 64
  ) {
    throw new Error("acp_descriptor_invalid");
  }
}

function terminalCapability(
  capabilities: Readonly<ClientCapabilities>,
): boolean {
  return capabilities.terminal === true;
}

function reservedRoutes(
  direction: AcpMethodDirection,
  kind: "request" | "notification",
  disposition: AcpReservedV1Disposition,
  methods: readonly string[],
): readonly AcpReservedV1Route[] {
  return methods.map((method) =>
    Object.freeze({ direction, kind, method, disposition }),
  );
}

function supportsSessionSetup(
  capabilities: Readonly<AgentCapabilities>,
  request:
    | NewSessionRequest
    | LoadSessionRequest
    | ForkSessionRequest
    | ResumeSessionRequest,
): boolean {
  if (
    request.additionalDirectories != null &&
    request.additionalDirectories.length > 0 &&
    capabilities.sessionCapabilities?.additionalDirectories == null
  ) {
    return false;
  }
  for (const server of request.mcpServers ?? []) {
    if (
      "type" in server &&
      server.type === "http" &&
      capabilities.mcpCapabilities?.http !== true
    ) {
      return false;
    }
    if (
      "type" in server &&
      server.type === "sse" &&
      capabilities.mcpCapabilities?.sse !== true
    ) {
      return false;
    }
    if (
      "type" in server &&
      server.type === "acp" &&
      capabilities.mcpCapabilities?.acp !== true
    ) {
      return false;
    }
  }
  return true;
}

function supportsPrompt(
  capabilities: Readonly<AgentCapabilities>,
  request: PromptRequest,
): boolean {
  return request.prompt.every((content) => {
    switch (content.type) {
      case "text":
      case "resource_link":
        return true;
      case "image":
        return capabilities.promptCapabilities?.image === true;
      case "audio":
        return capabilities.promptCapabilities?.audio === true;
      case "resource":
        return capabilities.promptCapabilities?.embeddedContext === true;
    }
  });
}

function supportsBooleanConfig(
  capabilities: Readonly<ClientCapabilities>,
): boolean {
  return capabilities.session?.configOptions?.boolean != null;
}

function supportsBooleanConfigCatalog(
  capabilities: Readonly<ClientCapabilities>,
  value: unknown,
): boolean {
  return (
    !Array.isArray(value) ||
    supportsBooleanConfig(capabilities) ||
    value.every((entry) => asRecord(entry)?.type !== "boolean")
  );
}

function validateInitializeRequestSemantics(value: unknown): boolean {
  if (!validateInitializeRequest(value)) return false;
  const request = value as InitializeRequest;
  if (request.protocolVersion !== SEDES_ACP_PROTOCOL_VERSION) return false;
  const capabilities = request.clientCapabilities;
  const encodings = capabilities?.positionEncodings ?? [];
  return new Set(encodings).size === encodings.length;
}

function validateInitializeResponseSemantics(value: unknown): boolean {
  if (!validateInitializeResponse(value)) return false;
  const response = value as InitializeResponse;
  if (
    !Number.isSafeInteger(response.protocolVersion) ||
    response.protocolVersion < 0 ||
    response.protocolVersion > 0xffff
  ) {
    return false;
  }
  const capabilities = response.agentCapabilities as
    Record<string, unknown> | undefined;
  const nes = asRecord(capabilities?.nes);
  const context = asRecord(nes?.context);
  const nesBoundsValid = ["recentFiles", "editHistory", "userActions"].every(
    (key) => {
      const capability = asRecord(context?.[key]);
      return isOptionalUint32(
        capability?.maxCount as number | null | undefined,
      );
    },
  );
  const authIds = new Set<string>();
  for (const method of response.authMethods ?? []) {
    if (!isBoundedLookup(method.id) || authIds.has(method.id)) return false;
    authIds.add(method.id);
    if ("type" in method && method.type === "env_var") {
      const variableNames = new Set<string>();
      for (const variable of method.vars) {
        if (
          !isBoundedLookup(variable.name) ||
          variableNames.has(variable.name)
        ) {
          return false;
        }
        variableNames.add(variable.name);
      }
    }
  }
  return nesBoundsValid;
}

function validateInitializeResponseForRequest(
  response: InitializeResponse,
  request: InitializeRequest,
): boolean {
  const selected = response.agentCapabilities?.positionEncoding;
  if (selected == null) return true;
  const advertised = request.clientCapabilities?.positionEncodings ?? [];
  return advertised.length === 0
    ? selected === "utf-16"
    : advertised.includes(selected);
}

function validateAuthenticateRequestSemantics(value: unknown): boolean {
  return (
    validateAuthenticateRequest(value) &&
    isBoundedLookup((value as AuthenticateRequest).methodId)
  );
}

function validateLogoutRequestSemantics(value: unknown): boolean {
  return validateLogoutRequest(value);
}

function validateNewSessionRequestSemantics(value: unknown): boolean {
  return validateNewSessionRequest(value) && validateSessionSetup(value);
}

function validateNewSessionResponseSemantics(value: unknown): boolean {
  return (
    validateNewSessionResponse(value) &&
    isBoundedLookup((value as NewSessionResponse).sessionId) &&
    validateSessionCatalogPayload(value)
  );
}

function validateLoadSessionRequestSemantics(value: unknown): boolean {
  return validateLoadSessionRequest(value) && validateSessionSetup(value);
}

function validateLoadSessionResponseSemantics(value: unknown): boolean {
  return (
    validateLoadSessionResponse(value) && validateSessionCatalogPayload(value)
  );
}

function validateResumeSessionRequestSemantics(value: unknown): boolean {
  return validateResumeSessionRequest(value) && validateSessionSetup(value);
}

function validateResumeSessionResponseSemantics(value: unknown): boolean {
  return (
    validateResumeSessionResponse(value) && validateSessionCatalogPayload(value)
  );
}

function validateForkSessionRequestSemantics(value: unknown): boolean {
  return validateForkSessionRequest(value) && validateSessionSetup(value);
}

function validateForkSessionResponseSemantics(value: unknown): boolean {
  return (
    validateForkSessionResponse(value) &&
    isBoundedLookup((value as ForkSessionResponse).sessionId) &&
    validateSessionCatalogPayload(value)
  );
}

function validateSessionSetup(value: unknown): boolean {
  const request = asRecord(value);
  if (!request || !isPortableAbsolutePath(request.cwd)) return false;
  if (request.sessionId != null && !isBoundedLookup(request.sessionId)) {
    return false;
  }
  const additionalDirectories = request.additionalDirectories;
  if (
    additionalDirectories != null &&
    (!Array.isArray(additionalDirectories) ||
      !additionalDirectories.every(isPortableAbsolutePath))
  ) {
    return false;
  }
  const mcpServers = request.mcpServers;
  if (!Array.isArray(mcpServers)) return true;
  const acpServerIds = new Set<string>();
  for (const server of mcpServers) {
    const record = asRecord(server);
    if (!record) return false;
    if (
      Object.hasOwn(record, "command") &&
      !isPortableAbsolutePath(record.command)
    ) {
      return false;
    }
    if (Object.hasOwn(record, "command") && Array.isArray(record.env)) {
      if (!validateUniqueEnvVariables(record.env)) return false;
    }
    if (
      (record.type === "http" || record.type === "sse") &&
      !isHttpUrl(record.url)
    ) {
      return false;
    }
    if (record.type === "acp") {
      if (!isBoundedLookup(record.serverId as unknown)) return false;
      if (acpServerIds.has(record.serverId as string)) return false;
      acpServerIds.add(record.serverId as string);
    }
  }
  return true;
}

function validateListSessionsRequestSemantics(value: unknown): boolean {
  if (!validateListSessionsRequest(value)) return false;
  const cwd = (value as ListSessionsRequest).cwd;
  return cwd == null || isPortableAbsolutePath(cwd);
}

function validateListSessionsResponseSemantics(value: unknown): boolean {
  if (!validateListSessionsResponse(value)) return false;
  const sessions = (value as ListSessionsResponse).sessions;
  const sessionIds = new Set<string>();
  return sessions.every((session) => {
    if (
      !isBoundedLookup(session.sessionId) ||
      sessionIds.has(session.sessionId)
    ) {
      return false;
    }
    sessionIds.add(session.sessionId);
    return (
      isPortableAbsolutePath(session.cwd) &&
      (session.additionalDirectories ?? []).every(isPortableAbsolutePath) &&
      (session.updatedAt == null || isRfc3339(session.updatedAt))
    );
  });
}

function validateRequestPermissionRequestSemantics(value: unknown): boolean {
  if (!validateRequestPermissionRequest(value)) return false;
  const request = value as RequestPermissionRequest;
  if (request.options.length === 0) return false;
  if (!isBoundedLookup(request.sessionId)) return false;
  const optionIds = new Set<string>();
  for (const option of request.options) {
    if (!isBoundedLookup(option.optionId) || optionIds.has(option.optionId)) {
      return false;
    }
    optionIds.add(option.optionId);
  }
  return validateToolCallSemantics(request.toolCall);
}

function validateRequestPermissionResponseSemantics(value: unknown): boolean {
  if (!validateRequestPermissionResponse(value)) return false;
  const outcome = (value as RequestPermissionResponse).outcome;
  return outcome.outcome === "cancelled" || isBoundedLookup(outcome.optionId);
}

function validatePromptRequestSemantics(value: unknown): boolean {
  return (
    validatePromptRequest(value) &&
    isBoundedLookup((value as PromptRequest).sessionId) &&
    (value as PromptRequest).prompt.every(validateContentBlockSemantics)
  );
}

function validatePromptResponseSemantics(value: unknown): boolean {
  if (!validatePromptResponse(value)) return false;
  const usage = (value as PromptResponse).usage;
  return (
    usage == null ||
    validateUnsignedSafeIntegerRecord(usage, [
      "totalTokens",
      "inputTokens",
      "outputTokens",
      "thoughtTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
    ])
  );
}

function validateSessionNotificationSemantics(value: unknown): boolean {
  if (!validateSessionNotification(value)) return false;
  const notification = value as SessionNotification;
  if (!isBoundedLookup(notification.sessionId)) return false;
  const update = asRecord(notification.update);
  if (!update) return false;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (
        (update.messageId == null || isBoundedLookup(update.messageId)) &&
        validateContentBlockSemantics(update.content)
      );
    case "tool_call":
    case "tool_call_update":
      return validateToolCallSemantics(update);
    case "available_commands_update":
      return validateAvailableCommands(update.availableCommands);
    case "config_option_update":
      return validateConfigCatalog(update.configOptions);
    case "current_mode_update":
      return isBoundedLookup(update.currentModeId);
    case "plan_update": {
      const plan = asRecord(update.plan);
      return !!plan && isBoundedLookup(plan.planId);
    }
    case "plan_removed":
      return isBoundedLookup(update.planId);
    case "session_info_update":
      return update.updatedAt == null || isRfc3339(update.updatedAt);
    case "usage_update": {
      if (!validateUnsignedSafeIntegerRecord(update, ["used", "size"])) {
        return false;
      }
      if ((update.used as number) > (update.size as number)) return false;
      const cost = asRecord(update.cost);
      return !cost || validateCostSemantics(cost);
    }
    default:
      return true;
  }
}

function validateToolCallSemantics(value: unknown): boolean {
  const toolCall = asRecord(value);
  if (!toolCall || !isBoundedLookup(toolCall.toolCallId)) return false;
  if (
    Array.isArray(toolCall.locations) &&
    !toolCall.locations.every((location) => {
      const record = asRecord(location);
      return (
        !!record &&
        isBoundedDisplayPath(record.path) &&
        isOptionalUint32(record.line as number | null | undefined)
      );
    })
  ) {
    return false;
  }
  return (
    !Array.isArray(toolCall.content) ||
    toolCall.content.every(validateToolCallContentSemantics)
  );
}

function validateToolCallContentSemantics(value: unknown): boolean {
  const content = asRecord(value);
  if (!content) return false;
  if (content.type === "diff") return isBoundedDisplayPath(content.path);
  if (content.type === "content") {
    return validateContentBlockSemantics(content.content);
  }
  if (content.type === "terminal") {
    return isBoundedLookup(content.terminalId);
  }
  return true;
}

/**
 * Tool locations and diff paths are provider display metadata, not filesystem
 * authority. Providers may report them relative to the session workspace even
 * though the ACP schema describes an absolute path. A backend must separately
 * resolve and authorize a path before using it for any file operation.
 */
function isBoundedDisplayPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= SEDES_ACP_MAXIMUM_PATH_BYTES
  );
}

function validateContentBlockSemantics(value: unknown): boolean {
  const content = asRecord(value);
  if (!content) return false;
  const annotations = asRecord(content.annotations);
  if (
    annotations?.priority != null &&
    (typeof annotations.priority !== "number" ||
      !Number.isFinite(annotations.priority))
  ) {
    return false;
  }
  if (content.type !== "resource_link") return true;
  return validateResourceLinkSemantics(content);
}

function validateResourceLinkSemantics(
  content: Record<string, unknown>,
): boolean {
  return (
    content.size == null ||
    (Number.isSafeInteger(content.size) && (content.size as number) >= 0)
  );
}

function validateTerminalOutputResponseSemantics(value: unknown): boolean {
  if (!validateTerminalOutputResponse(value)) return false;
  const exitStatus = asRecord((value as TerminalOutputResponse).exitStatus);
  return !exitStatus || validateTerminalExitSemantics(exitStatus);
}

function validateTerminalExitSemantics(
  value: Record<string, unknown>,
): boolean {
  const exitCode = value.exitCode;
  const signal = value.signal;
  const hasExitCode = exitCode != null;
  const hasSignal = signal != null;
  return (
    hasExitCode !== hasSignal &&
    (!hasExitCode || isOptionalUint32(exitCode as number)) &&
    (!hasSignal || isBoundedLookup(signal))
  );
}

function validateCostSemantics(value: Record<string, unknown>): boolean {
  return (
    typeof value.amount === "number" &&
    Number.isFinite(value.amount) &&
    value.amount >= 0 &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/u.test(value.currency)
  );
}

function validateUnsignedSafeIntegerRecord(
  value: unknown,
  keys: readonly string[],
): boolean {
  const record = asRecord(value);
  return (
    !!record &&
    keys.every((key) => {
      const candidate = record[key];
      return (
        candidate == null ||
        (Number.isSafeInteger(candidate) && (candidate as number) >= 0)
      );
    })
  );
}

function validateSessionCatalogPayload(value: unknown): boolean {
  const payload = asRecord(value);
  return (
    !!payload &&
    (payload.modes == null || validateModeCatalog(payload.modes)) &&
    (payload.configOptions == null ||
      validateConfigCatalog(payload.configOptions))
  );
}

function validateSetSessionConfigOptionRequestSemantics(
  value: unknown,
): boolean {
  if (!validateSetSessionConfigOptionRequest(value)) return false;
  const request = value as SetSessionConfigOptionRequest;
  return (
    isBoundedLookup(request.sessionId) &&
    isBoundedLookup(request.configId) &&
    (typeof request.value === "boolean" || isBoundedLookup(request.value))
  );
}

function validateSetSessionConfigOptionResponseSemantics(
  value: unknown,
): boolean {
  return (
    validateSetSessionConfigOptionResponse(value) &&
    validateConfigCatalog(
      (value as SetSessionConfigOptionResponse).configOptions,
    )
  );
}

function validateSetSessionConfigOptionResponseForRequest(
  response: SetSessionConfigOptionResponse,
  request: SetSessionConfigOptionRequest,
): boolean {
  const matches = response.configOptions.filter(
    (option) => option.id === request.configId,
  );
  return matches.length === 1 && matches[0]?.currentValue === request.value;
}

function validateSetSessionModeRequestSemantics(value: unknown): boolean {
  return (
    validateSetSessionModeRequest(value) &&
    isBoundedLookup((value as SetSessionModeRequest).sessionId) &&
    isBoundedLookup((value as SetSessionModeRequest).modeId)
  );
}

function validateSessionIdRequest<T>(
  official: AcpValueValidator<T>,
): AcpValueValidator<T> {
  return (value: unknown) => {
    if (!official(value)) return false;
    return isBoundedLookup(asRecord(value)?.sessionId);
  };
}

function validateTerminalIdRequest<T>(
  official: AcpValueValidator<T>,
): AcpValueValidator<T> {
  return (value: unknown) => {
    if (!official(value)) return false;
    const record = asRecord(value);
    return (
      !!record &&
      isBoundedLookup(record.sessionId) &&
      isBoundedLookup(record.terminalId)
    );
  };
}

function validateModeCatalog(value: unknown): boolean {
  const modes = asRecord(value);
  if (!modes || !Array.isArray(modes.availableModes)) return false;
  const ids = new Set<string>();
  for (const candidate of modes.availableModes) {
    const mode = asRecord(candidate);
    if (
      !mode ||
      !isBoundedLookup(mode.id) ||
      !isBoundedLookup(mode.name) ||
      ids.has(mode.id as string)
    ) {
      return false;
    }
    ids.add(mode.id as string);
  }
  return (
    isBoundedLookup(modes.currentModeId) &&
    ids.has(modes.currentModeId as string)
  );
}

function validateConfigCatalog(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const configIds = new Set<string>();
  for (const candidate of value) {
    const config = asRecord(candidate);
    if (
      !config ||
      !isBoundedLookup(config.id) ||
      !isBoundedLookup(config.name) ||
      configIds.has(config.id as string)
    ) {
      return false;
    }
    configIds.add(config.id as string);
    if (config.type !== "select") continue;
    if (!Array.isArray(config.options)) return false;
    const optionValues = new Set<string>();
    const groups = new Set<string>();
    const groupsOrOptions = config.options;
    const grouped = groupsOrOptions.some((entry) =>
      Object.hasOwn(asRecord(entry) ?? {}, "group"),
    );
    const options: unknown[] = [];
    if (grouped) {
      for (const candidateGroup of groupsOrOptions) {
        const group = asRecord(candidateGroup);
        if (
          !group ||
          !isBoundedLookup(group.group) ||
          !isBoundedLookup(group.name) ||
          groups.has(group.group as string) ||
          !Array.isArray(group.options)
        ) {
          return false;
        }
        groups.add(group.group as string);
        options.push(...group.options);
      }
    } else {
      options.push(...groupsOrOptions);
    }
    for (const candidateOption of options) {
      const option = asRecord(candidateOption);
      if (
        !option ||
        !isBoundedLookup(option.value) ||
        !isBoundedLookup(option.name) ||
        optionValues.has(option.value as string)
      ) {
        return false;
      }
      optionValues.add(option.value as string);
    }
    if (
      !isBoundedLookup(config.currentValue) ||
      !optionValues.has(config.currentValue as string)
    ) {
      return false;
    }
  }
  return true;
}

function validateAvailableCommands(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every((candidate) => {
    const command = asRecord(candidate);
    if (
      !command ||
      !isBoundedLookup(command.name) ||
      names.has(command.name as string)
    ) {
      return false;
    }
    names.add(command.name as string);
    return true;
  });
}

function isBoundedLookup(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= SEDES_ACP_MAXIMUM_LOOKUP_BYTES
  );
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRfc3339(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Protocol shape only; backend authority must canonicalize for its actual OS/root. */
function isPortableAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > SEDES_ACP_MAXIMUM_PATH_BYTES
  ) {
    return false;
  }
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)
  );
}

function validateReadTextFileRequestSemantics(value: unknown): boolean {
  return (
    validateReadTextFileRequest(value) &&
    ((request: ReadTextFileRequest) =>
      isBoundedLookup(request.sessionId) &&
      isPortableAbsolutePath(request.path) &&
      isOptionalPositiveUint32(request.line) &&
      isOptionalIntegerAtMost(
        request.limit,
        SEDES_ACP_MAXIMUM_TEXT_FILE_LINES,
      ))(value as ReadTextFileRequest)
  );
}

function validateWriteTextFileRequestSemantics(value: unknown): boolean {
  return (
    validateWriteTextFileRequest(value) &&
    isBoundedLookup((value as WriteTextFileRequest).sessionId) &&
    isPortableAbsolutePath((value as WriteTextFileRequest).path)
  );
}

function validateCreateTerminalRequestSemantics(value: unknown): boolean {
  if (!validateCreateTerminalRequest(value)) return false;
  const request = value as CreateTerminalRequest;
  return (
    isBoundedLookup(request.sessionId) &&
    typeof request.command === "string" &&
    request.command.length > 0 &&
    Buffer.byteLength(request.command, "utf8") <=
      SEDES_ACP_MAXIMUM_PATH_BYTES &&
    validateUniqueEnvVariables(request.env ?? []) &&
    (request.cwd == null || isPortableAbsolutePath(request.cwd)) &&
    (request.outputByteLimit == null ||
      (Number.isSafeInteger(request.outputByteLimit) &&
        request.outputByteLimit >= 0 &&
        request.outputByteLimit <= SEDES_ACP_MAXIMUM_TERMINAL_OUTPUT_BYTES))
  );
}

function validateUniqueEnvVariables(value: readonly unknown[]): boolean {
  const names = new Set<string>();
  for (const candidate of value) {
    const variable = asRecord(candidate);
    if (
      !variable ||
      !isBoundedLookup(variable.name) ||
      names.has(variable.name as string)
    ) {
      return false;
    }
    names.add(variable.name as string);
  }
  return true;
}

function validateCreateTerminalResponseSemantics(value: unknown): boolean {
  return (
    validateCreateTerminalResponse(value) &&
    isBoundedLookup((value as CreateTerminalResponse).terminalId)
  );
}

function validateWaitForTerminalExitResponseSemantics(value: unknown): boolean {
  if (!validateWaitForTerminalExitResponse(value)) return false;
  return validateTerminalExitSemantics(value as Record<string, unknown>);
}

function isOptionalPositiveUint32(value: number | null | undefined): boolean {
  return (
    value == null ||
    (Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff)
  );
}

function isOptionalUint32(value: number | null | undefined): boolean {
  return (
    value == null ||
    (Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff)
  );
}

function isOptionalIntegerAtMost(
  value: number | null | undefined,
  maximum: number,
): boolean {
  return (
    value == null ||
    (Number.isSafeInteger(value) && value >= 0 && value <= maximum)
  );
}
