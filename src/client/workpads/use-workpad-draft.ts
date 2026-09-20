import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkpadDraft } from "../../shared/protocol/workpads.js";
import type { ApiClient } from "../api/ApiClient.js";

export interface DraftEditor {
  draft: WorkpadDraft;
  text: string;
  baseText: string;
  remote?: WorkpadDraft;
}
export function useWorkpadDraft(api: ApiClient, onError: (message: string) => void) {
  const [editor, setEditorState] = useState<DraftEditor>();
  const ref = useRef(editor);
  const [saving, setSaving] = useState(false);
  const pending = useRef<Promise<WorkpadDraft> | undefined>(undefined);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const discarding = useRef(false);
  const setEditor = useCallback((value: DraftEditor | undefined) => { ref.current = value; setEditorState(value); }, []);
  const errorRef = useRef(onError); errorRef.current = onError;
  const acceptRemote = useCallback(async (draft: WorkpadDraft): Promise<boolean> => {
    if (!ref.current || draft.workpadId !== ref.current.draft.workpadId || draft.revision <= ref.current.draft.revision) return false;
    let baseText: string;
    try {
      baseText = draft.baseRevision === ref.current.draft.baseRevision
        ? ref.current.baseText : (await api.getWorkpadRevision(draft.workpadId, draft.baseRevision)).content;
    } catch (error) {
      const current = ref.current;
      if (current && current.draft.workpadId === draft.workpadId && current.draft.revision < draft.revision) setEditor({ ...current, remote: draft });
      throw error;
    }
    const current = ref.current;
    if (!current || draft.workpadId !== current.draft.workpadId || draft.revision <= current.draft.revision) return false;
    if (current.text !== current.draft.content) {
      // A clean server draft follows document commits. Keep unsynced typing
      // and its original base, but adopt the counter so reconciliation can save.
      if (draft.baseRevision !== current.draft.baseRevision && draft.content === baseText) {
        setEditor({ ...current, draft: { ...draft, baseRevision: current.draft.baseRevision }, remote: undefined });
        return true;
      }
      setEditor({ ...current, remote: draft });
    } else setEditor({ draft, text: draft.content, baseText });
    return false;
  }, [api, setEditor]);
  const save = useCallback(async (): Promise<WorkpadDraft> => {
    while (pending.current) await pending.current;
    if (discarding.current) throw new Error("Draft discard is in progress.");
    const value = ref.current;
    if (!value) throw new Error("No working draft is open.");
    if (value.remote) throw new Error("Resolve the draft conflict before saving.");
    if (value.text === value.draft.content) return value.draft;
    setSaving(true);
    // Pending includes recovery, so discard and event adoption cannot race a
    // recovery GET after the original PUT has already rejected.
    const operation = (async () => {
      try {
        const draft = await api.saveWorkpadDraft(value.draft.workpadId, { expectedRevision: value.draft.revision, baseRevision: value.draft.baseRevision, content: value.text });
        if (ref.current?.draft.workpadId === draft.workpadId) setEditor({ ...ref.current, draft });
        return draft;
      } catch (error) {
        let documentAdvanced = false;
        try {
          const remote = await api.getWorkpadDraft(value.draft.workpadId);
          if (remote.revision > value.draft.revision && remote.content === value.text && remote.baseRevision === value.draft.baseRevision) {
            // The write landed but its response was lost. Adopt its counter
            // without replacing any typing that arrived while saving.
            if (ref.current?.draft.workpadId === remote.workpadId && ref.current.draft.revision <= remote.revision) setEditor({ ...ref.current, draft: remote });
            return remote;
          }
          documentAdvanced = await acceptRemote(remote);
        } catch { /* Keep the unsynced local draft on a network failure. */ }
        if (documentAdvanced) throw new Error("The document changed. Review the latest version before saving.");
        throw error;
      }
    })();
    pending.current = operation;
    try { return await operation; }
    finally { pending.current = undefined; setSaving(false); }
  }, [api, setEditor, acceptRemote]);
  const discard = useCallback(async () => {
    if (discarding.current) return;
    const workpadId = ref.current?.draft.workpadId;
    discarding.current = true;
    window.clearTimeout(autosaveTimer.current);
    try {
      if (pending.current) await pending.current.catch(() => undefined);
      const current = ref.current;
      if (!current) return;
      await api.discardWorkpadDraft(current.draft.workpadId, current.draft.revision);
      if (ref.current?.draft.workpadId === current.draft.workpadId) setEditor(undefined);
    } finally {
      discarding.current = false;
      // A failed discard keeps the editor open. Restart its cancelled debounce
      // even when the user has not typed again since clicking Discard.
      if (ref.current?.draft.workpadId === workpadId && ref.current) setEditor({ ...ref.current });
    }
  }, [api, setEditor]);
  useEffect(() => {
    if (!editor || editor.remote || editor.text === editor.draft.content || discarding.current) return;
    const timer = window.setTimeout(() => { if (!discarding.current) void save().catch(error => errorRef.current(error instanceof Error ? error.message : "Could not sync draft.")); }, 2000);
    autosaveTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [editor, save]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (ref.current && (pending.current || ref.current.remote || ref.current.text !== ref.current.draft.content)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const adoptRemote = useCallback(async (draft: WorkpadDraft) => {
    // An event may arrive before this client's pending save response. Wait for
    // that response, then compare counters so the event is neither lost nor
    // allowed to roll the draft back to an older counter.
    if (pending.current) await pending.current.catch(() => undefined);
    await acceptRemote(draft);
  }, [acceptRemote]);
  return { editor, ref, setEditor, save, saving, adoptRemote, discard };
}
