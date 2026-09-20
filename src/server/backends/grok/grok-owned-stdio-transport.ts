import type { ExecutionEnvironmentChannelProvider } from "../../execution/environment-channel.js";
import type { ProviderTransportScope } from "../../provider-protocol/transport/assured-framed-transport.js";
import {
  OwnedNdjsonStdioTransportFactory,
  type OwnedNdjsonStdioTransport,
} from "../../provider-protocol/transport/owned-ndjson-stdio-transport.js";
import { grokOwnedStdioArguments } from "./grok-child-environment.js";
import "./grok-image-request-sizing.js";
import type { ResolvedGrokWorkspaceRuntimeConfiguration } from "./grok-runtime-config.js";

export class GrokOwnedStdioTransportFactory {
  readonly #scope: ProviderTransportScope;
  readonly #transport: OwnedNdjsonStdioTransportFactory;

  constructor(input: {
    readonly runtime: ResolvedGrokWorkspaceRuntimeConfiguration;
    readonly channels: ExecutionEnvironmentChannelProvider;
  }) {
    this.#scope = Object.freeze({
      ...input.runtime.scope,
      backendInstanceId: input.runtime.backendInstanceId,
      executionEnvironmentId: input.runtime.executionEnvironmentId,
    });
    this.#transport = new OwnedNdjsonStdioTransportFactory({
      // Session secrets can arrive after launch and span diagnostic lines.
      // Keep byte/exit diagnostics without retaining native stderr contents.
      retainStderr: false,
      scope: this.#scope,
      channels: input.channels,
      process: input.runtime.process,
      environment: input.runtime.environment,
      sensitiveValues: [
        input.runtime.workspace,
        input.runtime.environment.HOME,
        input.runtime.environment.GROK_HOME,
        input.runtime.environment.ALL_PROXY,
        input.runtime.environment.HTTPS_PROXY,
        input.runtime.environment.HTTP_PROXY,
        input.runtime.environment.NO_PROXY,
        input.runtime.environment.SSL_CERT_FILE,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
      commandArguments: grokOwnedStdioArguments({
        sandboxProfile: "off",
      }),
      assuranceDiagnosticPrefix: "grok",
      transportDiagnosticPrefix: "grok_owned_stdio",
    });
  }

  get scope(): ProviderTransportScope {
    return this.#scope;
  }

  async open(
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<OwnedNdjsonStdioTransport> {
    return await this.#transport.open(
      this.#scope,
      connectionGeneration,
      signal,
    );
  }
}
