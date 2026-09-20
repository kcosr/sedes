import type { ProviderTransportScope, FramedTransportFactory } from "../../../provider-protocol/transport/assured-framed-transport.js";
import type { ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { ResolvedCodexRuntimeConfiguration } from "../codex-runtime-config.js";
import { OwnedStdioTransportFactory } from "../transport/owned-stdio-transport.js";
import { UnixWebSocketTransportFactory } from "../transport/unix-websocket-transport.js";
import { TcpWebSocketTransportFactory } from "../transport/tcp-websocket-transport.js";

/** Same native transport implementation for local and persistent hosting. */
export function createCodexRuntimeTransport(input: {
  readonly scope: ProviderTransportScope;
  readonly configuration: ResolvedCodexRuntimeConfiguration;
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
}): FramedTransportFactory {
    if (
      input.configuration.connection.ownership === "external" &&
      input.configuration.connection.channel.type === "tcp_websocket"
    ) {
      return new TcpWebSocketTransportFactory({
        scope: input.scope,
        channels: input.environmentChannel,
        url: input.configuration.connection.channel.url,
        secretReference:
          input.configuration.connection.channel.authentication.secret,
      });
    }
    if (
      input.configuration.connection.ownership === "external" &&
      input.configuration.connection.channel.type === "unix_websocket"
    ) {
      return new UnixWebSocketTransportFactory({
        scope: input.scope,
        channels: input.environmentChannel,
        socketPath: input.configuration.connection.channel.socketPath,
      });
    }
    const configuration = input.configuration;
    if (
      configuration.connection.ownership !== "owned" ||
      !configuration.childEnvironment ||
      !configuration.nativeStoreHome ||
      !configuration.codexHome
    ) {
      throw new Error("codex_connection_channel_unreachable");
    }
    return new OwnedStdioTransportFactory({
      scope: input.scope,
      channels: input.environmentChannel,
      process: configuration.connection.channel.process,
      environment: configuration.childEnvironment,
      sqliteHome: configuration.nativeStoreHome,
      sensitiveValues: [
        configuration.codexHome,
        configuration.nativeStoreHome,
        configuration.connection.channel.workingDirectory,
        ...["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"].flatMap((name) => {
          const value = configuration.childEnvironment[name];
          return value ? [value] : [];
        }),
      ],
    });
}
