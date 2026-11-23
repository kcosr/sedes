import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LengthPrefixedSidecarFrameTransport } from "../../src/internal/sidecar-protocol/length-prefixed-frame-transport.js";
import {
  executionPolicyBytes,
  executionPolicyDigest,
  MAX_POLICY_BYTES,
  POLICY_BLOCK_BYTES,
} from "../../src/internal/sidecar-protocol/execution-policy.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type {
  SidecarByteStream,
  SidecarFrameLane,
} from "../../src/internal/sidecar-protocol/contracts.js";

// A discrete-event full-duplex serial link. Each side has one in-flight carrier
// write. The real transport selects the next queued frame at its writable boundary.
async function runFixture(backlogged: boolean, staging: boolean) {
  type Frame = {
    type: string;
    sequence?: number;
    value?: string;
    offset?: number;
  };
  type Timer = { at: number; run: () => void };
  const timers: Timer[] = [];
  let now = 0;
  const later = (delay: number, run: () => void) =>
    timers.push({ at: now + delay, run });
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const date = vi.spyOn(Date, "now").mockImplementation(() => now);
  let halted = false;
  function transport(receive: (frame: Frame) => void) {
    let end!: () => void;
    const eof = new Promise<void>((r) => {
      end = r;
    });
    const stream: SidecarByteStream = {
      bytes: {
        async *[Symbol.asyncIterator]() {
          await eof;
        },
      },
      closed: eof.then(() => ({ reason: "fixture_finished" })),
      close: async () => {
        end();
      },
      write: (frame) => {
        const envelope = JSON.parse(
          Buffer.from(frame).subarray(16).toString(),
        ) as Frame;
        return new Promise<void>((resolve) => {
          // 256,000 bits/second per direction, followed by 20ms one-way latency.
          later(frame.length / 32, () => {
            resolve();
            later(20, () => {
              if (!halted) receive(envelope);
            });
          });
        });
      },
    };
    return new LengthPrefixedSidecarFrameTransport({
      stream,
      assurance: { kind: "paced", carrierGeneration: 1 },
    });
  }
  const configuration = { environmentRevision: 1, operationsRevision: 1 };
  const service = new PersistentSidecarServiceRegistry({
    scope: {
      installationId: "i",
      tenantId: "t",
      principalId: "p",
      executionEnvironmentId: "e",
    },
    configuration,
    artifactSha256: "0".repeat(64),
    buildId: "test",
    runtimeWireVersion: 18,
  });
  const epoch = service.attach(configuration);
  const roots = Array.from({ length: 16 }, (_, i) => ({
    id: String(i),
    generation: 1,
    path: "/" + i.toString(16) + "x".repeat(32_699),
  }));
  const snapshot = { roots, backends: [], capabilities: [] };
  let remaining = MAX_POLICY_BYTES - executionPolicyBytes(snapshot).length;
  for (const root of roots) {
    const n = Math.min(32_768 - root.path.length, remaining);
    root.path += "x".repeat(n);
    remaining -= n;
  }
  const data = executionPolicyBytes(snapshot);
  expect(data.length).toBe(MAX_POLICY_BYTES);
  const binding = {
    incarnation: service.serviceIncarnation,
    controllerEpoch: epoch,
    revision: 1,
    digest: executionPolicyDigest(snapshot),
    transferId: randomUUID(),
  };
  const common = {
    wireVersion: 18,
    sessionNonce: "n".repeat(64),
    requestId: randomUUID(),
    requestNamespace: "sedes",
    capabilityId: "control",
    majorVersion: 3,
  };
  const outstanding = new Set<Promise<unknown>>();
  let failure: unknown;
  const track = (p: Promise<unknown>) => {
    outstanding.add(p);
    void p
      .catch((e) => {
        failure = e;
      })
      .finally(() => outstanding.delete(p));
  };
  const send = (
    link: LengthPrefixedSidecarFrameTransport,
    frame: Frame,
    lane: SidecarFrameLane,
  ) => {
    const encoded = Buffer.from(JSON.stringify({ ...common, ...frame }));
    if (frame.type === "files")
      expect(encoded.length + 16).toBeLessThanOrEqual(4096);
    return link.send(encoded, { lane });
  };
  let offset = 0,
    finished = 0,
    bulkCount = 0,
    bulkAtFinish = 0;
  const echoTimes: number[] = [],
    heartbeatTimes: number[] = [];
  const host = transport((frame) => {
    if (frame.type === "stage_ack") {
      offset = frame.offset!;
      stage();
    }
    if (frame.type === "applied") {
      finished = now;
      bulkAtFinish = bulkCount;
    }
    if (frame.type === "echo")
      echoTimes[frame.sequence!] = now - frame.sequence! * 200;
    if (frame.type === "pong")
      heartbeatTimes[frame.sequence!] = now - frame.sequence! * 5000;
    if (frame.type === "files") bulkCount++;
  });
  const main = transport((frame) => {
    if (frame.type === "probe" || frame.type === "ping") {
      const echo = frame.type === "probe";
      track(
        send(
          host,
          { type: echo ? "echo" : "pong", sequence: frame.sequence },
          echo ? "interactive" : "control",
        ),
      );
    } else if (frame.type === "stage") {
      const { offset } = service.stagePolicy(epoch, {
        ...binding,
        length: data.length,
        offset: frame.offset!,
        block: frame.value!,
      });
      track(send(host, { type: "stage_ack", offset }, "staging"));
    } else if (frame.type === "apply") {
      service.applyPolicy(epoch, { ...binding, base: null, configuration });
      track(send(host, { type: "applied" }, "control"));
    }
  });
  function stage() {
    if (offset === data.length) {
      track(send(main, { type: "apply" }, "control"));
      return;
    }
    const block = data
      .subarray(offset, offset + POLICY_BLOCK_BYTES)
      .toString("base64");
    track(send(main, { type: "stage", offset, value: block }, "staging"));
  }
  function bulk() {
    if (halted || now >= 120_000) return;
    // A fully backlogged producer offers the next frame at each writable boundary.
    // The ordinary workload offers one 3.8 KiB Files frame per second (< 1/2 link).
    const p = send(
      host,
      { type: "files", value: "f".repeat(3650) },
      "operation",
    );
    track(
      p.then(() => {
        if (backlogged) bulk();
        else later(1000, bulk);
      }),
    );
  }
  let probes = 0,
    heartbeats = 0;
  function probe() {
    const seq = probes++;
    track(send(main, { type: "probe", sequence: seq }, "interactive"));
    if (now < 119_800) later(200, probe);
  }
  function heartbeat() {
    const seq = heartbeats++;
    track(send(main, { type: "ping", sequence: seq }, "control"));
    if (now < 115_000) later(5000, heartbeat);
  }
  try {
    bulk();
    if (staging) stage();
    probe();
    heartbeat();
    while (timers.length) {
      timers.sort((left, right) => left.at - right.at);
      const event = timers.shift()!;
      if (event.at > 122_000) throw new Error("fixture stalled");
      now = event.at;
      event.run();
      // Drain native Promise continuations at each writable boundary.
      await new Promise<void>((r) => setImmediate(r));
      if (failure) throw failure;
    }
    await Promise.all(outstanding);
    expect(echoTimes).toHaveLength(probes);
    expect(heartbeatTimes).toHaveLength(heartbeats);
    expect(Math.max(...heartbeatTimes)).toBeLessThan(5000);
    if (staging) {
      expect(finished).toBeGreaterThan(0);
      expect(finished).toBeLessThan(120_000);
      expect(bulkAtFinish).toBeGreaterThan(0);
      expect(service.executionPolicy(epoch).roots).toHaveLength(16);
    }
    return {
      echoTimes,
      finished,
      bulkAtFinish,
      maxHeartbeat: Math.max(...heartbeatTimes),
    };
  } finally {
    halted = true;
    await Promise.all([
      main.close("fixture_finished"),
      host.close("fixture_finished"),
    ]);
    clock.mockRestore();
    date.mockRestore();
  }
}
describe("512 KiB policy delivery on a 256 kbit/s link with 40 ms RTT", () => {
  it.each([false, true])(
    "keeps PTY echo and heartbeat latency bounded (backlogged Files %s)",
    async (backlogged) => {
      const baseline = await runFixture(backlogged, false);
      const measured = await runFixture(backlogged, true);
      const echoes = measured.echoTimes;
      const differences = echoes
        .map((t, i) => t - baseline.echoTimes[i]!)
        .sort((a, b) => a - b);
      expect(
        differences[Math.ceil(differences.length * 0.95) - 1],
      ).toBeLessThan(500);
      expect(Math.max(...echoes)).toBeLessThan(1000);
    },
    20_000,
  );
});
