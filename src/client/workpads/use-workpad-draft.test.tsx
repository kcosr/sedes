// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import type { WorkpadDraft } from "../../shared/protocol/workpads.js";
import { useWorkpadDraft } from "./use-workpad-draft.js";
const initial: WorkpadDraft = { workpadId: "pad", revision: 0, baseRevision: 1, content: "Original", updatedAt: "2026-09-08T00:00:00Z" };
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("workpad working drafts", () => {
  it("debounces draft sync without committing document revisions", async () => {
    vi.useFakeTimers();
    const saveWorkpadDraft = vi.fn(async (_id, request) => ({ ...initial, ...request, revision: 1 }));
    const commitWorkpadDraft = vi.fn();
    const api = { saveWorkpadDraft, commitWorkpadDraft } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "Original plus notes", baseText: "Original" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(saveWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "Original plus notes" });
    expect(result.current.editor?.draft.revision).toBe(1);
    expect(commitWorkpadDraft).not.toHaveBeenCalled();
  });
  it("retains typing that arrives during a draft save", async () => {
    let resolve!: (value: WorkpadDraft) => void;
    const saveWorkpadDraft = vi.fn(() => new Promise<WorkpadDraft>(done => { resolve = done; }));
    const { result } = renderHook(() => useWorkpadDraft({ saveWorkpadDraft } as unknown as ApiClient, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "First change", baseText: "Original" }));
    let pending!: Promise<WorkpadDraft>;
    act(() => { pending = result.current.save(); });
    act(() => result.current.setEditor({ ...result.current.editor!, text: "Second change" }));
    await act(async () => { resolve({ ...initial, content: "First change", revision: 1 }); await pending; });
    expect(result.current.editor?.text).toBe("Second change");
    expect(result.current.editor?.draft.content).toBe("First change");
    expect(result.current.editor?.draft.revision).toBe(1);
  });
  it("preserves a local draft when another device wins the revision race", async () => {
    const remote = { ...initial, content: "Other device", revision: 2 };
    const api = { saveWorkpadDraft: vi.fn(async () => { throw new Error("Draft conflict"); }), getWorkpadDraft: vi.fn(async () => remote) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "My changes", baseText: "Original" }));
    await act(async () => { await expect(result.current.save()).rejects.toThrow("Draft conflict"); });
    expect(result.current.editor?.text).toBe("My changes");
    expect(result.current.editor?.remote).toEqual(remote);
  });
  it("recognizes a lost save response and preserves newer typing", async () => {
    let reject!: (error: Error) => void;
    const remote = { ...initial, content: "Sent text", revision: 1 };
    const api = { saveWorkpadDraft: vi.fn(() => new Promise<WorkpadDraft>((_resolve, fail) => { reject = fail; })), getWorkpadDraft: vi.fn(async () => remote) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "Sent text", baseText: initial.content }));
    let pending!: Promise<WorkpadDraft>;
    act(() => { pending = result.current.save(); });
    act(() => result.current.setEditor({ ...result.current.editor!, text: "Typed after sending" }));
    await act(async () => { reject(new Error("Response lost")); expect(await pending).toEqual(remote); });
    expect(result.current.editor).toMatchObject({ draft: remote, text: "Typed after sending", baseText: initial.content });
    expect(result.current.editor?.remote).toBeUndefined();
  });

  it("stops autosave on a known revision conflict even if the new base cannot be fetched", async () => {
    vi.useFakeTimers();
    const remote = { ...initial, content: "Other revision", revision: 2, baseRevision: 2 };
    const saveWorkpadDraft = vi.fn(async () => { throw new Error("Draft conflict"); });
    const api = { saveWorkpadDraft, getWorkpadDraft: vi.fn(async () => remote), getWorkpadRevision: vi.fn(async () => { throw new Error("Offline"); }) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "My changes", baseText: initial.content }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.editor?.remote).toEqual(remote);
    expect(result.current.editor?.text).toBe("My changes");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(saveWorkpadDraft).toHaveBeenCalledTimes(1);
  });

  it("retains the original base when failed-save recovery finds a clean draft following an agent commit", async () => {
    const remote = { ...initial, content: "Agent update", revision: 1, baseRevision: 2 };
    const api = { saveWorkpadDraft: vi.fn(async () => { throw new Error("Draft conflict"); }), getWorkpadDraft: vi.fn(async () => remote), getWorkpadRevision: vi.fn(async () => ({ content: remote.content })) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "My changes", baseText: initial.content }));
    await act(async () => { await expect(result.current.save()).rejects.toThrow("The document changed."); });
    expect(result.current.editor).toMatchObject({ text: "My changes", baseText: initial.content, draft: { revision: 1, baseRevision: 1 } });
    expect(result.current.editor?.remote).toBeUndefined();
  });

  it("waits for save recovery before discarding with the recovered counter", async () => {
    let recover!: (draft: WorkpadDraft) => void;
    const discardWorkpadDraft = vi.fn(async () => initial);
    const api = { saveWorkpadDraft: vi.fn(async () => { throw new Error("Response lost"); }), getWorkpadDraft: vi.fn(() => new Promise<WorkpadDraft>(resolve => { recover = resolve; })), discardWorkpadDraft } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "Sent text", baseText: initial.content }));
    let saving!: Promise<WorkpadDraft>;
    await act(async () => { saving = result.current.save(); });
    let discarding!: Promise<void>;
    act(() => { discarding = result.current.discard(); });
    expect(discardWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { recover({ ...initial, revision: 1, content: "Sent text" }); await saving; await discarding; });
    expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 1);
    expect(result.current.editor).toBeUndefined();
  });

  it("resumes autosave after a failed discard without requiring another keystroke", async () => {
    vi.useFakeTimers();
    const saveWorkpadDraft = vi.fn(async () => ({ ...initial, content: "My changes", revision: 1 }));
    const api = { saveWorkpadDraft, discardWorkpadDraft: vi.fn(async () => { throw new Error("Offline"); }) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "My changes", baseText: initial.content }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await expect(result.current.discard()).rejects.toThrow("Offline"); });
    expect(result.current.editor?.text).toBe("My changes");
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(saveWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "My changes" });
    expect(result.current.editor?.draft.revision).toBe(1);
  });

  it("adopts synced changes across devices only when local text is unchanged", async () => {
    const api = { getWorkpadRevision: vi.fn(async () => ({ content: "Original" })) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: initial.content, baseText: initial.content }));
    const remote = { ...initial, content: "Synced notes", revision: 1 };
    await act(async () => { await result.current.adoptRemote(remote); });
    expect(result.current.editor?.text).toBe("Synced notes");
    act(() => result.current.setEditor({ ...result.current.editor!, text: "Local typing" }));
    const newer = { ...remote, revision: 2, content: "Another edit" };
    await act(async () => { await result.current.adoptRemote(newer); });
    expect(result.current.editor?.text).toBe("Local typing");
    expect(result.current.editor?.remote).toEqual(newer);
  });
  it("does not lose a remote event that arrives during a local draft save", async () => {
    let resolve!: (value: WorkpadDraft) => void;
    const saveWorkpadDraft = vi.fn(() => new Promise<WorkpadDraft>(done => { resolve = done; }));
    const api = { saveWorkpadDraft, getWorkpadRevision: vi.fn(async () => ({ content: initial.content })) } as unknown as ApiClient;
    const { result } = renderHook(() => useWorkpadDraft(api, vi.fn()));
    act(() => result.current.setEditor({ draft: initial, text: "Local save", baseText: initial.content }));
    let save!: Promise<WorkpadDraft>;
    let event!: Promise<void>;
    act(() => { save = result.current.save(); event = result.current.adoptRemote({ ...initial, revision: 2, content: "Subsequent device edit" }); });
    await act(async () => { resolve({ ...initial, revision: 1, content: "Local save" }); await save; await event; });
    expect(result.current.editor?.draft.revision).toBe(2);
    expect(result.current.editor?.text).toBe("Subsequent device edit");
    await act(async () => { await result.current.adoptRemote({ ...initial, revision: 1, content: "Old event" }); });
    expect(result.current.editor?.text).toBe("Subsequent device edit");
  });

});
