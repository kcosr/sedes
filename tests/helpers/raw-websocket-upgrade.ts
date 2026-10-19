import { connect, type Socket } from "node:net";

export interface RawUpgradeRequest {
  readonly port: number;
  readonly path: string;
  readonly host?: string;
  readonly protocols?: readonly string[];
}

function upgradeRequestText(input: RawUpgradeRequest): string {
  return [
    `GET ${input.path} HTTP/1.1`,
    `Host: ${input.host ?? `127.0.0.1:${input.port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...(input.protocols ? [`Sec-WebSocket-Protocol: ${input.protocols.join(", ")}`] : []),
    "",
    "",
  ].join("\r\n");
}

/**
 * Sends a WebSocket upgrade request and resets the TCP connection immediately,
 * so the server's later answer fails with ECONNRESET/EPIPE.
 */
export async function sendUpgradeAndReset(input: RawUpgradeRequest): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = connect(input.port, "127.0.0.1", () => {
      socket.write(upgradeRequestText(input), () => {
        socket.resetAndDestroy();
        resolve();
      });
    });
    socket.on("error", () => undefined);
    socket.once("close", () => resolve());
  });
}

/**
 * Sends a WebSocket upgrade request and waits for the server to close the
 * connection, returning everything it wrote before closing.
 */
export async function upgradeUntilServerCloses(
  input: RawUpgradeRequest & { readonly timeoutMilliseconds: number },
): Promise<{ readonly response: string }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket: Socket = connect(input.port, "127.0.0.1", () => {
      socket.write(upgradeRequestText(input));
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw_upgrade_not_closed_by_server"));
    }, input.timeoutMilliseconds);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve({ response: Buffer.concat(chunks).toString("latin1") });
    });
  });
}

/** Collects process-level crash signals for the duration of a test body. */
export function captureProcessCrashes(): {
  readonly errors: unknown[];
  dispose(): void;
} {
  const errors: unknown[] = [];
  const record = (error: unknown) => errors.push(error);
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  return {
    errors,
    dispose() {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    },
  };
}
