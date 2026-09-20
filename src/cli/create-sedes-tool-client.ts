import type { SedesAgentToolEndpoint } from "./sedes-agent-tool-endpoint.js";
import { SedesToolHttpClient } from "./sedes-tool-api-client.js";
import {
  SedesToolApiError,
  type SedesAgentToolCallerCredential,
  type SedesToolClient,
} from "./sedes-tool-client.js";
import {
  SedesToolLocalClient,
  type SedesToolLocalSocketConnector,
} from "./sedes-tool-local-client.js";

export function createSedesToolClient(input: {
  readonly endpoint: SedesAgentToolEndpoint;
  readonly credential: SedesAgentToolCallerCredential;
  readonly fetch?: typeof globalThis.fetch;
  readonly connect?: SedesToolLocalSocketConnector;
  readonly transportRequestId?: () => string;
}): SedesToolClient {
  if (input.endpoint.type === "http") {
    return new SedesToolHttpClient(
      input.endpoint.origin,
      input.credential,
      input.fetch,
    );
  }
  if (input.credential.kind !== "thread_source") {
    throw new SedesToolApiError(
      "invalid_environment",
      "SEDES_AGENT_TOOL_CLIENT_TOKEN requires an HTTP(S) endpoint.",
      false,
    );
  }
  return new SedesToolLocalClient(
    input.endpoint.socketPath,
    input.credential.value,
    input.connect,
    input.transportRequestId,
    undefined,
    input.endpoint.type === "npipe" ? input.endpoint.capability : undefined,
  );
}
