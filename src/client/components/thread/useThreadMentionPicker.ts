import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ListMentionCandidatesQuery, MentionCandidatePage, NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import type { ApiClient } from "../../api/ApiClient.js";

type PickerScope = ListMentionCandidatesQuery["scope"];
type PickerRow =
  | { kind: "thread"; thread: NormalizedApplicationThreadSummary }
  | { kind: "all" | "more" | "retry" };

interface SearchResult {
  key: string;
  threads: readonly NormalizedApplicationThreadSummary[];
  nextCursor?: string;
  status: "ready" | "loading" | "failed";
}

export function useThreadMentionPicker({ open, sourceThreadId, api, query, liveThreads = [], onSelect, onRestoreQuery }: {
  open: boolean;
  sourceThreadId: string;
  api?: Pick<ApiClient, "listMentionCandidates">;
  query: string;
  liveThreads?: readonly NormalizedApplicationThreadSummary[];
  onSelect(thread: NormalizedApplicationThreadSummary): void;
  onRestoreQuery?(query: string): void;
}) {
  const [scope, setScope] = useState<PickerScope>("project");
  const [result, setResult] = useState<SearchResult>();
  const [request, setRequest] = useState<{ key: string; cursor?: string }>();
  const [selection, setSelection] = useState<{ key: string; index: number | "all" }>();
  const rootQuery = useRef("");
  const confirmFirstMatch = useRef<string | undefined>(undefined);
  const key = JSON.stringify([sourceThreadId, scope, query]);
  const cursor = request?.key === key ? request.cursor : undefined;

  useEffect(() => {
    if (!open || !api) {
      confirmFirstMatch.current = undefined;
      setScope("project");
      setRequest(undefined);
      setSelection(undefined);
      setResult(undefined);
      return;
    }
    if (request && request.key !== key) {
      setRequest(undefined);
      return;
    }
    const controller = new AbortController();
    setResult(old => ({
      key, threads: cursor && old?.key === key ? old.threads : [],
      nextCursor: cursor, status: "loading",
    }));
    const load = async () => {
      try {
        const page: MentionCandidatePage = await api.listMentionCandidates(sourceThreadId, {
          scope, query: query.trim(), cursor,
        }, controller.signal);
        if (controller.signal.aborted) return;
        setResult(old => {
          const previous = cursor && old?.key === key ? old.threads : [];
          const threads = [...new Map([...previous, ...page.threads].map(thread => [thread.id, thread])).values()];
          return { key, threads, nextCursor: page.nextCursor, status: "ready" };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (cursor && error && typeof error === "object" && "code" in error && error.code === "cursor_invalid") {
          setSelection(undefined);
          setRequest(undefined);
        } else {
          setResult(old => ({ key, threads: old?.key === key ? old.threads : [], nextCursor: cursor, status: "failed" }));
        }
      }
    };
    const timer = query && !cursor ? window.setTimeout(() => void load(), 100) : undefined;
    if (timer === undefined) void load();
    return () => {
      if (confirmFirstMatch.current === key) confirmFirstMatch.current = undefined;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, open, key, cursor, request, query, scope, sourceThreadId]);

  const current = result?.key === key ? result : undefined;
  const status = current?.status ?? "loading";
  const latest = useMemo(() => new Map(liveThreads.map(thread => [thread.id, thread])), [liveThreads]);
  const rows: PickerRow[] = (current?.threads ?? []).flatMap(thread => {
    const shown = latest.get(thread.id) ?? thread;
    return shown.inventoryState === "archived" ? [] : [{ kind: "thread" as const, thread: shown }];
  });
  if (status === "failed") rows.push({ kind: "retry" });
  else if (current?.nextCursor) rows.push({ kind: "more" });
  if (scope === "project") rows.push({ kind: "all" });
  const preferred = selection?.key === key ? selection.index : undefined;
  // Raw unmatched tokens such as @types/node still submit with Enter. Users can
  // explicitly move onto All threads to continue searching outside this project.
  const selectedIndex = preferred === "all" ? rows.findIndex(row => row.kind === "all")
    : preferred !== undefined ? Math.min(preferred, rows.length - 1)
    : rows[0]?.kind === "thread" || rows[0]?.kind === "retry" ? 0 : -1;

  const first = rows[0]?.kind === "thread" ? rows[0].thread : undefined;
  useEffect(() => {
    if (!open || status === "loading" || confirmFirstMatch.current !== key) return;
    confirmFirstMatch.current = undefined;
    if (status === "ready" && first) onSelect(first);
  }, [open, key, status, first, onSelect]);

  const setSelectedIndex = (index: number) => {
    confirmFirstMatch.current = undefined;
    setSelection({ key, index: rows[index]?.kind === "all" ? "all" : index });
  };

  const back = () => {
    if (scope !== "all") return;
    const previous = rootQuery.current;
    setSelection({ key: JSON.stringify([sourceThreadId, "project", previous]), index: "all" });
    if (query !== previous) onRestoreQuery?.(previous);
    setScope("project");
    setRequest(undefined);
  };
  const choose = (index: number) => {
    confirmFirstMatch.current = undefined;
    const row = rows[index];
    if (!row) return;
    switch (row.kind) {
      case "thread": onSelect(row.thread); break;
      case "all":
        rootQuery.current = query;
        setSelection(undefined);
        setRequest(undefined);
        setScope("all");
        break;
      case "more":
      case "retry":
        if (status === "loading") return;
        setSelection({ key, index });
        setRequest({ key, cursor: current?.nextCursor });
        break;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return false;
    const { key: pressed } = event;
    if ((pressed === "ArrowDown" || pressed === "ArrowUp") && rows.length > 0) {
      const index = selectedIndex < 0 ? (pressed === "ArrowDown" ? 0 : rows.length - 1)
        : (selectedIndex + (pressed === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      setSelectedIndex(index);
    } else if (pressed === "ArrowLeft" && scope === "all") back();
    else if (pressed === "Enter" || pressed === "Tab") {
      if (selectedIndex >= 0) choose(selectedIndex);
      else if (status === "loading") confirmFirstMatch.current = key;
      else if (status === "ready") return false;
    } else if (pressed === "ArrowRight" && rows[selectedIndex]?.kind === "all") choose(selectedIndex);
    else return false;
    event.preventDefault();
    return true;
  };
  return { scope, rows, status, selectedIndex, setSelectedIndex, choose, back, onKeyDown };
}

export type ThreadMentionPickerMenu = ReturnType<typeof useThreadMentionPicker>;
