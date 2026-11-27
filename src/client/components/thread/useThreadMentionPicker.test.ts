// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MentionCandidatePage, NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { useThreadMentionPicker } from "./useThreadMentionPicker.js";

const thread = (id: string) => ({ id }) as NormalizedApplicationThreadSummary;

it("ignores superseded responses and aborts pending search on dismissal", async () => {
  let resolveStale!: (page: MentionCandidatePage) => void;
  const stale = new Promise<MentionCandidatePage>(resolve => { resolveStale = resolve; });
  const listMentionCandidates = vi.fn().mockReturnValueOnce(stale).mockResolvedValue({ threads: [thread("new")] });
  const api = { listMentionCandidates };
  const { result, rerender } = renderHook(({ query, open }) =>
    useThreadMentionPicker({ api, query, open, sourceThreadId: "source", onSelect: vi.fn() }),
    { initialProps: { query: "", open: true } });
  await waitFor(() => expect(listMentionCandidates).toHaveBeenCalledOnce());
  rerender({ query: "new", open: true });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(listMentionCandidates.mock.calls[0]![2].aborted).toBe(true);
  await act(() => resolveStale({ threads: [thread("stale")] }));
  expect(result.current.rows).toEqual([{ kind: "thread", thread: thread("new") }, { kind: "all" }]);
  rerender({ query: "new", open: false });
  expect(listMentionCandidates.mock.calls[1]![2].aborted).toBe(true);
});

it("restarts invalidated pagination and deduplicates threads moved during paging", async () => {
  const listMentionCandidates = vi.fn()
    .mockResolvedValueOnce({ threads: [thread("a")], nextCursor: "one" })
    .mockResolvedValueOnce({ threads: [thread("a"), thread("b")], nextCursor: "two" })
    .mockRejectedValueOnce({ code: "cursor_invalid" })
    .mockResolvedValueOnce({ threads: [thread("c")] });
  const api = { listMentionCandidates };
  const { result } = renderHook(() => useThreadMentionPicker({ api, query: "", open: true, sourceThreadId: "source", onSelect: vi.fn() }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  act(() => result.current.choose(1));
  await waitFor(() => expect(result.current.rows).toHaveLength(4));
  expect(result.current.selectedIndex).toBe(1);
  act(() => result.current.choose(2));
  await waitFor(() => expect(result.current.rows[0]).toEqual({ kind: "thread", thread: thread("c") }));
  expect(listMentionCandidates.mock.calls.map(([, input]) => input.cursor)).toEqual([undefined, "one", "two", undefined]);
});
