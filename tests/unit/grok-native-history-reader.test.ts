import { describe, expect, it, vi } from "vitest";
import { GrokNativeHistoryReader } from "../../src/server/backends/grok/grok-native-history-reader.js";
import type { GrokSessionUpdatesChunk } from "../../src/server/backends/grok/grok-acp-dialect.js";
import type {
  AcpRequestOptions,
  AcpRequestSettlement,
} from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import { AcpDeliveryError } from "../../src/server/provider-protocol/bindings/acp-v1/index.js";

describe("Grok native history reader", () => {
  it("settles source-ordered chunks before the response and forces one-update chunks", async () => {
    let reader!: GrokNativeHistoryReader;
    const request = vi.fn(async (wire) => {
      reader.acceptChunk(chunk(wire.sessionId, 0, false, "one"));
      reader.acceptChunk(chunk(wire.sessionId, 1, true, "two"));
      return successSettlement({
        totalCount: 2,
        chunkCount: 2,
        lastEventId: "event-2",
        promptStarts: [0],
      });
    });
    reader = new GrokNativeHistoryReader({ request });

    await expect(
      reader.read({
        sessionId: "session-1",
        cwd: "/workspace",
        offset: -2,
        limit: 2,
      }),
    ).resolves.toEqual({
      updates: [
        chunk("session-1", 0, false, "one").updates[0],
        chunk("session-1", 1, true, "two").updates[0],
      ],
      totalCount: 2,
      lastEventId: "event-2",
      promptStarts: [0],
    });
    expect(request).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        cwd: "/workspace",
        offset: -2,
        limit: 2,
        stream: true,
        chunkSize: 1,
      },
      expect.objectContaining({
        abandonOnCancellation: true,
        cancellationSignal: expect.any(AbortSignal),
        deadlineMilliseconds: null,
      }),
    );
  });

  it("waits for source chunks queued after the metadata response", async () => {
    let reader!: GrokNativeHistoryReader;
    const request = vi.fn(async () =>
      successSettlement({
        totalCount: 2,
        chunkCount: 2,
        lastEventId: "event-2",
        promptStarts: [0],
      }),
    );
    reader = new GrokNativeHistoryReader({ request });

    const reading = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reader.acquiring).toBe(true);
    reader.acceptChunk(chunk("session-1", 0, false, "one"));
    reader.acceptChunk(chunk("session-1", 1, true, "two"));
    await expect(reading).resolves.toEqual({
      updates: [
        chunk("session-1", 0, false, "one").updates[0],
        chunk("session-1", 1, true, "two").updates[0],
      ],
      totalCount: 2,
      lastEventId: "event-2",
      promptStarts: [0],
    });
  });

  it("drains a late chunk tail when cancellation wins after metadata", async () => {
    let call = 0;
    const reader = new GrokNativeHistoryReader({
      request: async () => {
        call += 1;
        return successSettlement(
          call === 1
            ? { totalCount: 2, chunkCount: 2, promptStarts: [0] }
            : { totalCount: 0, chunkCount: 0, promptStarts: [] },
        );
      },
    });
    const controller = new AbortController();
    const reading = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(reading).rejects.toMatchObject({
      code: "grok_native_history_aborted",
      retryable: true,
    });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    reader.acceptChunk(chunk("session-1", 0, false, "one"));
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    reader.acceptChunk(chunk("session-1", 1, true, "two"));
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
  });

  it("keeps a post-cutover cancellation tail out of a successor read", async () => {
    let reader!: GrokNativeHistoryReader;
    let call = 0;
    const controller = new AbortController();
    reader = new GrokNativeHistoryReader({
      request: async () => {
        call += 1;
        if (call > 1) {
          return successSettlement({
            totalCount: 0,
            chunkCount: 0,
            promptStarts: [],
          });
        }
        return {
          ...successSettlement({
            totalCount: 2,
            chunkCount: 2,
            promptStarts: [0],
          }),
          commitNotificationCutover: async (commit) => {
            const response = commit();
            controller.abort();
            return response;
          },
        };
      },
    });

    await expect(
      reader.read({
        sessionId: "session-1",
        cwd: "/workspace",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "grok_native_history_aborted" });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    reader.acceptChunk(chunk("session-1", 0, false, "stale-one"));
    reader.acceptChunk(chunk("session-1", 1, true, "stale-two"));
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
  });

  it("times out an abandoned tail and poisons the unsafe connection reader", async () => {
    const onAbandonedDrainTimeout = vi.fn();
    const reader = new GrokNativeHistoryReader({
      abandonedDrainDeadlineMilliseconds: 5,
      onAbandonedDrainTimeout,
      request: async () =>
        successSettlement({
          totalCount: 1,
          chunkCount: 1,
          promptStarts: [],
        }),
    });
    const controller = new AbortController();
    const reading = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(reading).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });

    await vi.waitFor(() =>
      expect(onAbandonedDrainTimeout).toHaveBeenCalledOnce(),
    );
    expect(reader.acquiring).toBe(false);
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "grok_native_history_stream_invalid",
      retryable: false,
    });
  });

  it("latches capacity and correlation failures onto only the active acquisition", async () => {
    let reader!: GrokNativeHistoryReader;
    let call = 0;
    reader = new GrokNativeHistoryReader({
      maximumRetainedBytes: 180,
      request: async (wire) => {
        call += 1;
        const sessionId = call === 2 ? "wrong-session" : wire.sessionId;
        reader.acceptChunk(
          chunk(sessionId, 0, true, call === 3 ? "ok" : "x".repeat(256)),
        );
        return successSettlement({
          totalCount: 1,
          chunkCount: 1,
          promptStarts: [],
        });
      },
    });

    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "grok_native_history_capacity_exceeded",
      retryable: true,
    });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "grok_native_history_stream_invalid",
      retryable: false,
    });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toMatchObject({ totalCount: 1 });
  });

  it("rejects overlap and keeps a cancelled tail out of the next acquisition", async () => {
    let reader!: GrokNativeHistoryReader;
    let call = 0;
    const request = vi.fn(async (wire, options) => {
      call += 1;
      if (call === 1) {
        return await new Promise<
          AcpRequestSettlement<{
            totalCount: number;
            chunkCount: number;
            promptStarts: readonly number[];
          }>
        >((resolve) => {
          options.cancellationSignal?.addEventListener(
            "abort",
            () => {
              reader.acceptChunk(chunk(wire.sessionId, 0, true, "cancel-tail"));
              resolve(
                successSettlement({
                  totalCount: 1,
                  chunkCount: 1,
                  promptStarts: [],
                }),
              );
            },
            { once: true },
          );
        });
      }
      return successSettlement({
        totalCount: 0,
        chunkCount: 0,
        promptStarts: [],
      });
    });
    reader = new GrokNativeHistoryReader({ request });
    const controller = new AbortController();
    const active = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    await expect(
      reader.read({ sessionId: "session-2", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "grok_native_history_busy",
      retryable: true,
    });
    controller.abort();
    await expect(active).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });

    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({
      updates: [],
      totalCount: 0,
      promptStarts: [],
    });
  });

  it("consumes an empty source chunk but rejects its data shape locally", async () => {
    let reader!: GrokNativeHistoryReader;
    reader = new GrokNativeHistoryReader({
      request: async (wire) => {
        reader.acceptChunk({
          sessionId: wire.sessionId,
          index: 0,
          updates: [],
          done: true,
        });
        return successSettlement({
          totalCount: 1,
          chunkCount: 1,
          promptStarts: [],
        });
      },
    });

    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({
      code: "grok_native_history_stream_invalid",
      retryable: false,
    });
  });

  it("does not disguise cancellation carrier failure as a request-local abort", async () => {
    const controller = new AbortController();
    const reader = new GrokNativeHistoryReader({
      request: async () => {
        controller.abort();
        throw new AcpDeliveryError(
          "acp_binding_closed",
          "sent_outcome_unknown",
        );
      },
    });

    await expect(
      reader.read({
        sessionId: "session-1",
        cwd: "/workspace",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "acp_binding_closed",
      delivery: "sent_outcome_unknown",
    });
  });

  it("drains stale abandoned chunks through done before admitting the next read", async () => {
    let rejectFirst!: (error: unknown) => void;
    let call = 0;
    const reader = new GrokNativeHistoryReader({
      request: async () => {
        call += 1;
        if (call === 1) {
          return await new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        return successSettlement({
          totalCount: 0,
          chunkCount: 0,
          promptStarts: [],
        });
      },
    });
    const controller = new AbortController();
    const abandoned = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    reader.acceptChunk(chunk("session-1", 0, false, "partial"));
    controller.abort();
    rejectFirst(
      new AcpDeliveryError(
        "acp_binding_request_cancelled",
        "sent_outcome_unknown",
      ),
    );
    await expect(abandoned).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });

    reader.acceptChunk(chunk("session-1", 99, true, "spurious done"));
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    reader.acceptChunk(chunk("session-1", 1, true, "stale tail"));
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
  });

  it("releases an abandoned empty stream when its payload-free settlement arrives", async () => {
    let rejectFirst!: (error: unknown) => void;
    let firstOptions: AcpRequestOptions | undefined;
    let call = 0;
    const reader = new GrokNativeHistoryReader({
      request: async (_request, options) => {
        call += 1;
        if (call === 1) {
          firstOptions = options;
          return await new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        return successSettlement({
          totalCount: 0,
          chunkCount: 0,
          promptStarts: [],
        });
      },
    });
    const controller = new AbortController();
    const abandoned = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    controller.abort();
    rejectFirst(
      new AcpDeliveryError(
        "acp_binding_request_cancelled",
        "sent_outcome_unknown",
      ),
    );
    await expect(abandoned).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });
    expect(reader.acquiring).toBe(true);
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    firstOptions?.onAbandonedSettlement?.();
    expect(reader.acquiring).toBe(false);
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
  });

  it("admits the next read immediately after proven-unsent abandonment", async () => {
    let call = 0;
    const reader = new GrokNativeHistoryReader({
      request: async (_wire, options) => {
        call += 1;
        if (call === 1) {
          await new Promise<void>((resolve) => {
            options.cancellationSignal?.addEventListener(
              "abort",
              () => resolve(),
              { once: true },
            );
          });
          throw new AcpDeliveryError(
            "acp_binding_request_cancelled",
            "not_sent",
          );
        }
        return successSettlement({
          totalCount: 0,
          chunkCount: 0,
          promptStarts: [],
        });
      },
    });
    const controller = new AbortController();
    const abandoned = reader.read({
      sessionId: "session-1",
      cwd: "/workspace",
      signal: controller.signal,
    });
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });
    await expect(
      reader.read({ sessionId: "session-1", cwd: "/workspace" }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
  });
});

function successSettlement<Response>(
  response: Response,
): AcpRequestSettlement<Response> {
  return {
    kind: "success",
    response,
    inboundSequence: 1,
    commitNotificationCutover: async (commit) => commit(),
  };
}

function chunk(
  sessionId: string,
  index: number,
  done: boolean,
  text: string,
): GrokSessionUpdatesChunk {
  return {
    sessionId,
    index,
    updates: [
      {
        timestamp: index,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      },
    ],
    done,
  };
}
