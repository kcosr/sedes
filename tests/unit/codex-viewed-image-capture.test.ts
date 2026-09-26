import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexViewedImageCaptureCoordinator } from "../../src/server/backends/codex/codex-viewed-image-capture.js";
import type { CodexViewedImageCandidate } from "../../src/server/backends/codex/codex-history-projector.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import type { ViewedImageCaptureInput } from "../../src/server/output-artifacts/viewed-image-capture.js";

const binding: ConversationBinding = {
  tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "thread",
  backendInstanceId: "codex", connectionProfileId: "connection", executionEnvironmentId: "local",
  backendConversationId: "native-thread", createdAt: "2026-01-01T00:00:00.000Z",
};
function candidate(index: number, completed = true): CodexViewedImageCandidate {
  return { nativeTurnId: "turn", nativeItemId: `view-${index}`, publicationKey: `view-${index}`,
    absolutePath: `/workspace/image-${index}.png`, completed, retained: false,
    identity: { backendItemId: `image-${index}`, backendTurnId: "turn", sourceOrder: index * 2 + 1 } };
}

afterEach(() => vi.useRealTimers());

describe("Codex viewed-image capture subscriptions", () => {
  it("keeps a page within one deadline, cancels its reads, and never starts candidates outside its budget", async () => {
    vi.useFakeTimers();
    const inputs: ViewedImageCaptureInput[] = [];
    const capture = vi.fn(async (input: ViewedImageCaptureInput) => {
      inputs.push(input);
      return new Promise<undefined>(() => undefined);
    });
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured: vi.fn() });
    const read = coordinator.capturePage(Array.from({ length: 9 }, (_, index) => candidate(index)));
    expect(capture).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    await read;
    expect(inputs.every(input => input.signal?.aborted)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(4);
    coordinator.close();
  });

  it("does not capture starts or automatically retry failed notifications, while explicit history can retry", async () => {
    const capture = vi.fn(async () => undefined);
    const onCaptured = vi.fn();
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured });
    coordinator.schedule([candidate(1, false)]);
    expect(capture).not.toHaveBeenCalled();
    coordinator.schedule([candidate(1)]);
    await Promise.resolve();
    coordinator.schedule([candidate(1)]);
    expect(capture).toHaveBeenCalledTimes(1);
    await coordinator.capturePage([candidate(1)]);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onCaptured).not.toHaveBeenCalled();
    coordinator.close();
  });

  it("does not crawl candidates skipped by the initial window budget on later reprojection", async () => {
    const capture = vi.fn(async () => undefined);
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured: vi.fn() });
    const window = Array.from({ length: 12 }, (_, index) => candidate(index));
    coordinator.schedule(window, 4);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(4);
    coordinator.schedule(window);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(4);
    coordinator.schedule([...window, candidate(12)]);
    await Promise.resolve();
    expect(capture).toHaveBeenCalledTimes(5);
    coordinator.close();
  });

  it("keeps retry suppression for retained failures without exhausting later live windows", async () => {
    const capture = vi.fn(async () => undefined);
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured: vi.fn() });
    for (let index = 0; index < 4200; index += 1) {
      coordinator.schedule([candidate(index)]);
      coordinator.schedule([candidate(index)]);
      await Promise.resolve();
    }
    expect(capture).toHaveBeenCalledTimes(4200);
    coordinator.close();
  });

  it("installs retained children without capturing them and lets a successful page refresh the live window", async () => {
    const capture = vi.fn(async (input: ViewedImageCaptureInput) =>
      input.publicationKey === "view-8" ? undefined : { artifactId: input.publicationKey } as never);
    const onCaptured = vi.fn();
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured });
    coordinator.schedule([{ ...candidate(1), retained: true }]);
    expect(capture).not.toHaveBeenCalled();
    await coordinator.capturePage([{ ...candidate(0), retained: true },
      ...Array.from({ length: 8 }, (_, index) => candidate(index + 1))]);
    // A page captures its newest candidates first, like the live window.
    expect(capture.mock.calls.map(([input]) => input.publicationKey)).toEqual(["view-5", "view-6", "view-7", "view-8"]);
    expect(onCaptured).toHaveBeenCalledTimes(1);
    coordinator.close();
  });

  it("releases a canceled page subscription without canceling the separately owned live subscription", async () => {
    const signals: AbortSignal[] = [];
    const capture = vi.fn(async (input: ViewedImageCaptureInput) => {
      signals.push(input.signal!);
      return new Promise<undefined>(() => undefined);
    });
    const coordinator = new CodexViewedImageCaptureCoordinator({ binding, capture: { capture }, onCaptured: vi.fn() });
    coordinator.schedule([candidate(1)]);
    const caller = new AbortController();
    const page = coordinator.capturePage([candidate(1)], caller.signal);
    caller.abort();
    await page;
    expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
    coordinator.close();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});
