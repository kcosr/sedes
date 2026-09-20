import type { Socket } from "node:net";
import { SidecarFrameWriteError, type SidecarByteStream, type SidecarByteStreamClosure } from "../../internal/sidecar-protocol/contracts.js";

/** Closing a controller's socket never closes the service or owned children. */
export function sidecarSocketByteStream(socket: Socket): SidecarByteStream {
  let reason = "sidecar_socket_closed";
  let failure: Error | undefined;
  const closed = new Promise<SidecarByteStreamClosure>((resolve) => {
    socket.once("error", (error) => { failure = error; });
    socket.once("close", () => resolve({ reason, ...(failure ? { cause: failure } : {}) }));
  });
  return {
    bytes: socket,
    closed,
    write: async (bytes, options) => {
      if (socket.destroyed || options?.signal?.aborted) {
        throw new SidecarFrameWriteError("sidecar_socket_write_unavailable", "not_sent");
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          options?.signal?.removeEventListener("abort", abort);
          if (error) reject(new SidecarFrameWriteError("sidecar_socket_write_failed", "sent_outcome_unknown", { cause: error }));
          else resolve();
        };
        const abort = () => {
          finish(new Error("sidecar_socket_write_cancelled"));
          socket.destroy();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        socket.write(bytes, finish);
      });
    },
    close: async (closeReason) => {
      reason = closeReason;
      socket.destroy();
      await closed;
    },
  };
}
