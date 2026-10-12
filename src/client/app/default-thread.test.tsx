// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeVoiceStore } from "../voice/NativeVoiceStore.js";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { DefaultThreadProvider, defaultThreadStorageKey, useDefaultThread } from "./default-thread.js";

afterEach(() => { cleanup(); localStorage.clear(); });
const scope = { profileId: "desktop", serverOrigin: "https://sedes.example", identity: "alice" };
const thread = { id: "thread-one", title: { text: "Assistant" }, available: true, inventoryState: "active" } as NormalizedApplicationThreadSummary;
function Choice() { const value = useDefaultThread()!; return <><output>{value.threadId ?? "none"}</output><button onClick={() => void value.setThread(thread)}>Choose</button><button onClick={() => void value.setThread(null)}>Clear</button></>; }
it("persists one choice per profile, server and identity and clears it explicitly", () => {
  const view = render(<DefaultThreadProvider scope={scope}><Choice /></DefaultThreadProvider>);
  fireEvent.click(screen.getByText("Choose"));
  expect(screen.getByRole("status")).toHaveTextContent("thread-one");
  expect(localStorage.getItem(defaultThreadStorageKey(scope))).toBe("thread-one");
  view.rerender(<DefaultThreadProvider scope={{...scope, identity:"bob"}}><Choice /></DefaultThreadProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("none");
  view.rerender(<DefaultThreadProvider scope={{...scope, serverOrigin:"https://other.example"}}><Choice /></DefaultThreadProvider>);
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
