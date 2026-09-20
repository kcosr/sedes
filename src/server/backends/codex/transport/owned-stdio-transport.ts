import { isAbsolute as pathIsAbsolute } from "node:path";
import type {
  ExecutionEnvironmentChannelProvider,
  PreparedEnvironmentOwnedProcess,
} from "../../../execution/environment-channel.js";
import {
  OwnedNdjsonStdioTransportFactory,
  type OwnedNdjsonStdioLimits,
  type OwnedNdjsonStdioTransport,
} from "../../../provider-protocol/transport/owned-ndjson-stdio-transport.js";
import type {
  FramedTransportFactory,
  FramedTransportLifecycleObserver,
  ProviderTransportScope,
} from "../../../provider-protocol/transport/assured-framed-transport.js";

/** Codex-private launch policy for the generic owned NDJSON stdio engine. */
export class OwnedStdioTransportFactory implements FramedTransportFactory {
  readonly #transport: OwnedNdjsonStdioTransportFactory;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly process: PreparedEnvironmentOwnedProcess;
    readonly environment: Readonly<Record<string, string>>;
    readonly sqliteHome: string;
    readonly limits?: Partial<OwnedNdjsonStdioLimits>;
    readonly sensitiveValues?: readonly string[];
    /** Test fixtures only. Production uses the exact app-server command. */
    readonly commandArguments?: readonly string[];
  }) {
    this.#transport = new OwnedNdjsonStdioTransportFactory({
      // Session secrets can arrive after launch and span diagnostic lines.
      // Keep byte/exit diagnostics without retaining native stderr contents.
      retainStderr: false,
      scope: input.scope,
      channels: input.channels,
      process: input.process,
      environment: input.environment,
      commandArguments:
        input.commandArguments ??
        buildOwnedStdioAppServerArguments(input.sqliteHome),
      ...(input.limits ? { limits: input.limits } : {}),
      ...(input.sensitiveValues
        ? { sensitiveValues: input.sensitiveValues }
        : {}),
      assuranceDiagnosticPrefix: "codex",
      transportDiagnosticPrefix: "codex_owned_stdio",
    });
  }

  async open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
    lifecycle?: FramedTransportLifecycleObserver,
  ): Promise<OwnedNdjsonStdioTransport> {
    return await this.#transport.open(
      expectedScope,
      connectionGeneration,
      signal,
      lifecycle,
    );
  }
}

export function buildOwnedStdioAppServerArguments(
  sqliteHome: string | undefined,
): readonly string[] {
  if (!sqliteHome || !pathIsAbsolute(sqliteHome)) {
    throw new Error("codex_owned_stdio_sqlite_home_invalid");
  }
  return Object.freeze([
    "app-server",
    "--config",
    `sqlite_home=${JSON.stringify(sqliteHome)}`,
    "--strict-config",
    "--listen",
    "stdio://",
  ]);
}
