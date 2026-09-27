import { randomUUID } from "node:crypto";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { decodeOpenCodeNativeFailure, encodeOpenCodeNativeFailure, parseOpenCodeMutationControl,
  parseOpenCodeMutationInput, parseOpenCodeMutationOutput, parseOpenCodeReadInput, parseOpenCodeReadOutput } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import type { OpenCodeMutationControl, OpenCodeNativePort, OpenCodeMutationMethod, OpenCodeMutationInput,
  OpenCodeReadMethod, OpenCodeReadInput } from "../../src/server/backends/opencode/opencode-native-port.js";

export function openCodeTestMutationControl(step = "test"): OpenCodeMutationControl {
  return { identity: { origin: "application", applicationOperationId: randomUUID(), operationKind: "action", step }, deadlineAt: Date.now() + 30_000 };
}

/** The production host is shared. Framed mode exercises its exact JSON DTO boundary,
 * deliberately without pretending this fixture qualifies SSH/outbound transport. */
export function createOpenCodeNativePortFixture(client: OpenCodeHttpClient,
  options: { readonly framed?: boolean; readonly directory?: string; readonly sessionID?: string } = {}) {
  const host = new OpenCodeNativeHost({ tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
    backendInstanceId: "backend", runtimeId: randomUUID(), nativeGeneration: randomUUID() }, new OpenCodeHttpNativeAdapter(client), {
    assertCurrent: async () => {}, installSessionEnvironment: async () => { throw new Error("environment fixture not configured"); },
    ensureMcpRegistration: async () => { throw new Error("MCP fixture not configured"); },
  }, client.lifetime);
  const direct = host.acquire({ directory: options.directory ?? "/workspace", session: {
    applicationThreadId: "thread", nativeSessionID: options.sessionID ?? "ses_owned", bindingFingerprint: "binding",
  } });
  if (!options.framed) return direct;
  const transfer = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const wire: OpenCodeNativePort = {
    ...direct,
    read: async <K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>, readOptions?: { signal?: AbortSignal; deadlineAt?: number }) => {
      try {
        const request = transfer(parseOpenCodeReadInput(method, input));
        return parseOpenCodeReadOutput(method, request, transfer(await direct.read(method, request, readOptions)));
      } catch (error) { throw decodeOpenCodeNativeFailure(transfer(encodeOpenCodeNativeFailure(error, false))); }
    },
    mutate: async <K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl, mutationOptions?: { signal?: AbortSignal }) => {
      const request = transfer(parseOpenCodeMutationInput(method, input));
      const metadata = transfer(parseOpenCodeMutationControl(control));
      try { return parseOpenCodeMutationOutput(method, request, transfer(await direct.mutate(method, request, metadata, mutationOptions))); }
      catch (error) { throw decodeOpenCodeNativeFailure(transfer(encodeOpenCodeNativeFailure(error, true))); }
    },
    outcome: async (method, identity) => transfer(await direct.outcome(method, transfer(identity))),
    acknowledgeMutation: (method, identity) => direct.acknowledgeMutation(method, transfer(identity)),
    acknowledgeOperation: identity => direct.acknowledgeOperation(transfer(identity)),
    observe: input => {
      const observation = direct.observe(input);
      return { ...observation, ready: observation.ready.then(transfer), drain: () => observation.drain().map(transfer),
        get failure() { return observation.failure; } };
    },
  };
  return wire;
}
