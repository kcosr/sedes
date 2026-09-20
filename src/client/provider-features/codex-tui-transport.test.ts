// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import { browserCodexTuiTransportFactory } from "./codex-tui-transport.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => vi.unstubAllGlobals());

describe("BrowserCodexTuiTransport", () => {
  it("uses one-time subprotocol admission and the exact v1 frame contract", async () => {
    const api = {
      createCodexTuiAdmission: vi.fn(async () => ({
        token: "a".repeat(43),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        resourceGeneration: 7,
      })),
      codexTuiWebSocketUrl: vi.fn(
        () => "wss://sedes.test/api/provider-feature-terminal",
      ),
    } as unknown as ApiClient;
    const output = vi.fn();
    const ready = vi.fn();
    const exited = vi.fn();
    const states: string[] = [];
    const transport = browserCodexTuiTransportFactory(
      api,
      "thread-1",
      7,
    )({
      onState: (state) => states.push(state),
      onOutput: output,
      onReady: ready,
      onError: vi.fn(),
      onExit: exited,
    });

    expect(transport.input("before open")).toBe(false);
    transport.resize(80, 24);
    transport.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.protocols).toEqual(["sedes.codex-tui.v1", "a".repeat(43)]);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.sent.slice(0, 1).map((frame) => JSON.parse(frame))).toEqual([
      { v: 1, type: "request_refit", columns: 80, rows: 24 },
    ]);

    expect(transport.input("λ")).toBe(true);
    transport.resize(80, 24);
    transport.requestRefit(100, 30);
    expect(socket.sent.slice(1).map((frame) => JSON.parse(frame))).toEqual([
      { v: 1, type: "input", data: "zrs" },
      { v: 1, type: "resize", columns: 80, rows: 24 },
      { v: 1, type: "request_refit", columns: 100, rows: 30 },
    ]);

    const bytes = new Uint8Array([27, 91, 109]);
    socket.onmessage?.({ data: bytes.buffer });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: 3 }),
    );
    socket.onmessage?.({
      data: JSON.stringify({ v: 1, type: "ready", columns: 80, rows: 24 }),
    });
    expect(ready).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(states).toContain("synchronizing");
    expect(states).toContain("ready");
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: "exit",
        exitCode: null,
        signal: null,
      }),
    });
    expect(exited).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("exited");
  });

  it("fails closed on an unknown control shape", async () => {
    const onError = vi.fn();
    const api = {
      createCodexTuiAdmission: vi.fn(async () => ({
        token: "b".repeat(43),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        resourceGeneration: 8,
      })),
      codexTuiWebSocketUrl: () =>
        "ws://sedes.test/api/provider-feature-terminal",
    } as unknown as ApiClient;
    const transport = browserCodexTuiTransportFactory(
      api,
      "thread-1",
      8,
    )({
      onState: vi.fn(),
      onOutput: vi.fn(),
      onReady: vi.fn(),
      onError,
      onExit: vi.fn(),
    });
    transport.connect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { v: 1, type: "request_sync" },
    ]);
    socket.onmessage?.({
      data: JSON.stringify({ type: "ready", cols: 80, rows: 24 }),
    });
    expect(onError).toHaveBeenCalledWith(
      "The terminal server sent an invalid frame.",
    );
    expect(socket.readyState).toBe(3);
  });

  it("mints a fresh admission for bounded reconnect attempts", async () => {
    vi.useFakeTimers();
    try {
      const createAdmission = vi.fn(async () => ({
        token: "c".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        resourceGeneration: 11,
      }));
      const states: string[] = [];
      const api = {
        createCodexTuiAdmission: createAdmission,
        codexTuiWebSocketUrl: () =>
          "ws://sedes.test/api/provider-feature-terminal",
      } as unknown as ApiClient;
      const transport = browserCodexTuiTransportFactory(
        api,
        "thread-1",
        11,
      )({
        onState: (state) => states.push(state),
        onOutput: vi.fn(),
        onReady: vi.fn(),
        onError: vi.fn(),
        onExit: vi.fn(),
      });
      transport.connect();
      await vi.advanceTimersByTimeAsync(0);

      const delays = [750, 1_500, 3_000, 6_000, 8_000, 8_000];
      for (const delay of delays) {
        const socket = FakeWebSocket.instances.at(-1)!;
        socket.open();
        socket.onmessage?.({
          data: JSON.stringify({
            v: 1,
            type: "error",
            code: "terminal_unavailable",
            message: "Try again.",
            retryable: true,
          }),
        });
        socket.onclose?.();
        await vi.advanceTimersByTimeAsync(delay);
      }
      const finalSocket = FakeWebSocket.instances.at(-1)!;
      finalSocket.open();
      finalSocket.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: "error",
          code: "terminal_unavailable",
          message: "Still unavailable.",
          retryable: true,
        }),
      });
      finalSocket.onclose?.();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(createAdmission).toHaveBeenCalledTimes(7);
      expect(FakeWebSocket.instances).toHaveLength(7);
      expect(states.at(-1)).toBe("failed");
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
