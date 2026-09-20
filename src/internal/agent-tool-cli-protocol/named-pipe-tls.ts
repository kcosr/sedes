import { createConnection, type Socket } from "node:net";
import tls from "node:tls";

const IDENTITY = "sedes-agent-tools-v3";
// PSK authenticates both ends and encrypts credentials even if another local
// account can enumerate or impersonate the named pipe. No certificate fallback.
const TLS_OPTIONS = {
  minVersion: "TLSv1.2" as const,
  maxVersion: "TLSv1.2" as const,
  ciphers: "PSK-AES256-GCM-SHA384",
};

export function createAgentToolCliNamedPipeServer(
  capability: string,
  handshakeTimeout: number,
): tls.Server {
  const psk = capabilityKey(capability);
  const server = tls.createServer({
    ...TLS_OPTIONS,
    handshakeTimeout,
    pskCallback: (_socket, identity) => identity === IDENTITY ? psk : null,
  });
  server.on("tlsClientError", () => {
    // Failed admission never reaches the relay.
  });
  return server;
}

export function connectAgentToolCliNamedPipe(
  socketPath: string,
  capability: string,
  connect: (path: string) => Socket = (value) => createConnection({ path: value }),
): tls.TLSSocket {
  const psk = capabilityKey(capability);
  return tls.connect({
    ...TLS_OPTIONS,
    socket: connect(socketPath),
    // There are no certificates in PSK-only TLS; peer possession of the PSK is
    // mandatory for this sole admitted cipher and checked by the TLS handshake.
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: IDENTITY, psk }),
  });
}

function capabilityKey(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("agent_tool_cli_pipe_capability_invalid");
  }
  return Buffer.from(value, "hex");
}
