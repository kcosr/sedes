import type { z } from "zod";
import type { SidecarByteStream } from "./contracts.js";
import { SIDECAR_MANAGEMENT_MAXIMUM_BYTES } from "./service-management-v1.js";

/** A single bounded management record precedes an optional runtime byte stream. */
export async function readSidecarManagementRecord<Value>(
  stream: SidecarByteStream, schema: z.ZodType<Value>, signal: AbortSignal,
): Promise<{ readonly value: Value; readonly stream: SidecarByteStream }> {
  const iterator = stream.bytes[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let length = 0;
  let suffix: Buffer = Buffer.alloc(0);
  let value: Value;
  try {
    for (;;) {
      const next = await nextWithSignal(iterator, signal);
      if (next.done) throw new Error("sidecar_management_response_incomplete");
      const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      const newline = bytes.indexOf(10);
      const prefix = newline < 0 ? bytes : bytes.subarray(0, newline);
      length += prefix.byteLength;
      if (length > SIDECAR_MANAGEMENT_MAXIMUM_BYTES) throw new Error("sidecar_management_record_too_large");
      chunks.push(prefix);
      if (newline < 0) continue;
      suffix = bytes.subarray(newline + 1);
      const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
      value = schema.parse(JSON.parse(json));
      break;
    }
  } catch (error) {
    await stream.close("sidecar_management_record_invalid").catch(() => undefined);
    throw error;
  }
  return {
    value,
    stream: {
      ...stream,
      bytes: (async function* () {
        if (suffix.byteLength > 0) yield suffix;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      })(),
    },
  };
}

export async function writeSidecarManagementRecord(stream: SidecarByteStream, value: unknown, signal?: AbortSignal): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > SIDECAR_MANAGEMENT_MAXIMUM_BYTES) throw new Error("sidecar_management_record_too_large");
  await stream.write(bytes, signal ? { signal } : undefined);
}

function nextWithSignal(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void iterator.next().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
