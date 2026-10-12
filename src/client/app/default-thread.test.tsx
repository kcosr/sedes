// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeVoiceStore } from "../voice/NativeVoiceStore.js";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { DefaultThreadProvider, DefaultThreadResolutionProvider, defaultThreadChoices, defaultThreadScope, defaultThreadStorageKey, useDefaultThread } from "./default-thread.js";
import type { ApplicationClientState, ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { voiceRecordingTarget } from "../voice/voice-recording-target.js";
import { voiceSettings, voiceSnapshot } from "../voice/native-voice-test-fixture.js";
import { ELECTRON_LOCAL_CONNECTION_PROFILE_ID } from "./electron-connections.js";

afterEach(() => { cleanup(); localStorage.clear(); });
const scope = { profileId: "desktop", serverKey: "https://sedes.example", identity: "alice" };
const thread = { id: "thread-one", title: { text: "Assistant" }, available: true, inventoryState: "active" } as NormalizedApplicationThreadSummary;

it("keeps Managed Local selection across transport ports while separating other profiles and identities", () => {
  const local = (port: number, identity = "alice") => defaultThreadScope(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, `http://127.0.0.1:${port}`, identity);
  expect(defaultThreadStorageKey(local(31001))).toBe(defaultThreadStorageKey(local(31002)));
  expect(defaultThreadStorageKey(local(31001, "bob"))).not.toBe(defaultThreadStorageKey(local(31001)));
  expect(defaultThreadStorageKey(defaultThreadScope("direct", "http://127.0.0.1:31001", "alice")))
    .not.toBe(defaultThreadStorageKey(defaultThreadScope("direct", "http://127.0.0.1:31002", "alice")));
});

function resolutionStore(readThreadSummary: ApplicationClientStore["api"]["readThreadSummary"]) {
  const listeners = new Set<() => void>();
  let state = { status: "ready", authoritative: true, connection: "connected", snapshot: { threads: [] } } as unknown as ApplicationClientState;
  const store = { api: { readThreadSummary }, getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as ApplicationClientStore;
  return { store, publish(threads: readonly NormalizedApplicationThreadSummary[]) {
    state = { ...state, snapshot: { ...state.snapshot!, threads: [...threads] } };
    act(() => listeners.forEach(listener => listener()));
  }};
}
function ResolvedChoice() {
  const value = useDefaultThread()!;
  const choices = defaultThreadChoices([], value.thread);
  const native = voiceSnapshot({ settings: voiceSettings({ voiceThreadId: value.threadId }) });
  return <><span data-testid="resolved">{value.thread ? `${value.thread.title.text}:${value.thread.inventoryState}` : "none"}</span>
    <span data-testid="resolving">{String(value.resolving)}</span><span data-testid="voice-target">{voiceRecordingTarget(choices, native, null)?.threadId ?? "none"}</span></>;
}
function resolvedView(store: ApplicationClientStore) {
  return <DefaultThreadProvider scope={scope}><DefaultThreadResolutionProvider store={store}><ResolvedChoice /></DefaultThreadResolutionProvider></DefaultThreadProvider>;
}
it("resolves an older fork after reload for navigation and voice, preferring fresh inventory thereafter", async () => {
  localStorage.setItem(defaultThreadStorageKey(scope), thread.id);
  const read = vi.fn().mockResolvedValue(thread);
  const fixture = resolutionStore(read);
  render(resolvedView(fixture.store));
  await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("Assistant:active"));
  expect(read).toHaveBeenCalledWith(thread.id, expect.any(AbortSignal));
  expect(screen.getByTestId("voice-target")).toHaveTextContent(thread.id);
  fixture.publish([{ ...thread, title: { text: "Renamed" }, inventoryState: "archived" }]);
  expect(screen.getByTestId("resolved")).toHaveTextContent("Renamed:archived");
  expect(screen.getByTestId("voice-target")).toHaveTextContent("none");
});
it("does not use a removed or inaccessible default", async () => {
  localStorage.setItem(defaultThreadStorageKey(scope), thread.id);
  render(resolvedView(resolutionStore(vi.fn().mockRejectedValue(new Error("not_found"))).store));
  await waitFor(() => expect(screen.getByTestId("resolving")).toHaveTextContent("false"));
  expect(screen.getByTestId("resolved")).toHaveTextContent("none");
  expect(screen.getByTestId("voice-target")).toHaveTextContent("none");
});
it("fences a same-ID response to its connection store and aborts the old request", async () => {
  localStorage.setItem(defaultThreadStorageKey(scope), thread.id);
  let finish!: (thread: NormalizedApplicationThreadSummary) => void;
  const oldRead = vi.fn((_id: string, _signal?: AbortSignal) => new Promise<NormalizedApplicationThreadSummary>(resolve => { finish = resolve; }));
  const first = resolutionStore(oldRead);
  const view = render(resolvedView(first.store));
  const signal = oldRead.mock.calls[0]![1] as AbortSignal;
  const second = resolutionStore(vi.fn().mockResolvedValue({ ...thread, title: { text: "New connection" } }));
  view.rerender(resolvedView(second.store));
  expect(signal.aborted).toBe(true);
  expect(screen.getByTestId("resolved")).toHaveTextContent("none");
  await act(async () => finish(thread));
  await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("New connection:active"));
});
function Choice() { const value = useDefaultThread()!; return <><output>{value.threadId ?? "none"}</output><button onClick={() => void value.setThread(thread)}>Choose</button><button onClick={() => void value.setThread(null)}>Clear</button></>; }
it("persists one choice per profile, server and identity and clears it explicitly", () => {
  const view = render(<DefaultThreadProvider scope={scope}><Choice /></DefaultThreadProvider>);
  fireEvent.click(screen.getByText("Choose"));
  expect(screen.getByRole("status")).toHaveTextContent("thread-one");
  expect(localStorage.getItem(defaultThreadStorageKey(scope))).toBe("thread-one");
  view.rerender(<DefaultThreadProvider scope={{...scope, identity:"bob"}}><Choice /></DefaultThreadProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("none");
  view.rerender(<DefaultThreadProvider scope={{...scope, serverKey:"https://other.example"}}><Choice /></DefaultThreadProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("none");
  view.rerender(<DefaultThreadProvider scope={scope}><Choice /></DefaultThreadProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("thread-one");
  fireEvent.click(screen.getByText("Clear"));
  expect(localStorage.getItem(defaultThreadStorageKey(scope))).toBeNull();
});
it("observes only storage updates for its own connection", () => {
  render(<DefaultThreadProvider scope={scope}><Choice /></DefaultThreadProvider>);
  act(() => window.dispatchEvent(new StorageEvent("storage", { storageArea:localStorage, key:defaultThreadStorageKey({...scope, identity:"bob"}), newValue:"other" })));
  expect(screen.getByRole("status")).toHaveTextContent("none");
  act(() => window.dispatchEvent(new StorageEvent("storage", { storageArea:localStorage, key:defaultThreadStorageKey(scope), newValue:"thread-two" })));
  expect(screen.getByRole("status")).toHaveTextContent("thread-two");
});

it("uses Android voice's existing selection as the single shared authority", async () => {
  const listeners = new Set<() => void>();
  let state = { pending: false, native: { settings: { voiceThreadId: "voice-selected", voiceThreadTitle: "Existing" } } };
  const publish = (id: string | null) => {
    state = { pending: false, native: { settings: { voiceThreadId: id!, voiceThreadTitle: "Updated" } } };
    listeners.forEach(listener => listener());
  };
  const update = vi.fn(async (patch: { voiceThreadId: string | null }) => publish(patch.voiceThreadId));
  const native = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    update,
  } as unknown as NativeVoiceStore;
  render(<DefaultThreadProvider scope={scope} native={native}><Choice /></DefaultThreadProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("voice-selected");
  await act(async () => fireEvent.click(screen.getByText("Choose")));
  expect(update).toHaveBeenCalledWith({ voiceThreadId: thread.id, voiceThreadTitle: "Assistant" });
  expect(screen.getByRole("status")).toHaveTextContent(thread.id);
  act(() => publish("changed-from-voice"));
  expect(screen.getByRole("status")).toHaveTextContent("changed-from-voice");
  expect(localStorage.getItem(defaultThreadStorageKey(scope))).toBeNull();
});
