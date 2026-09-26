import { DialogPortalContainerContext } from "../ui/dialog.js";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import { QuestionInboxButton, QuestionInboxPanel } from "./QuestionInbox.js";
import * as Popover from "@radix-ui/react-popover";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { recordComposerInputDiagnostic } from "../../app/diagnostics.js";
import { flushSync } from "react-dom";
import {
  normalizedDraftSchema,
  type ContextExcerpt,
  type NormalizedDraft,
  type NormalizedStash,
  type ComposerCommandDescriptor,
  type ComposerSkillDescriptor,
  type ComposerAttachmentDescriptor,
  type ComposerTaskReference,
  COMPOSER_ATTACHMENT_LIMITS,
} from "../../../shared/index.js";
import { hasDeliverableComposerInput } from "../../../shared/index.js";
import {
  DeliveryRecoveryRequiredError,
  useThreadStore,
  type ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { relativeTime } from "../../lib/time.js";
import {
  ArrowUp,
  Merge,
  Layers,
  ChevronDown,
  Check,
  ArchiveRestore,
  Paperclip,
  Search,
  Sparkles,
  Square,
  TextCursorInput,
  Trash2,
  ListTodo,
  CircleCheck,
  AlertTriangle,
  LoaderCircle,
  X,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@client/components/ui/dropdown-menu";
import { ProviderFeatureComposerActions } from "../../provider-features/registry.js";
import {
  CodexTuiTerminalControlContext,
  MOBILE_TUI_MEDIA_QUERY,
} from "../../provider-features/codex-tui.js";
import { MAXIMUM_CODEX_TUI_INPUT_BYTES } from "../../provider-features/codex-tui-transport.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { TerminalBottomControls } from "../../terminals/TerminalBottomControls.js";
import { ContextUsageMeter } from "./ContextUsageMeter.js";
import { ThreadSettingsControls } from "./ThreadSettingsControls.js";
import {
  clearRetainedComposerDeliveryState,
  getRetainedComposerDeliveryState,
  setRetainedComposerDeliveryState,
} from "./ComposerDeliveryCoordinator.js";
import {
  useComposerDraftCoordinator,
  type ContextExcerptStagingSnapshot,
} from "../../context-excerpts/coordinator.js";
import {
  ContextExcerptList,
  contextExcerptArraysEqual,
} from "../../context-excerpts/ContextExcerptCard.js";
import {
  getPromptsPlacement,
  getMobileComposerRefocusAfterSend,
  getRightOptionFocusesComposer,
  getShowPromptsTab,
  subscribePromptsPlacement,
  subscribeShowPromptsTab,
} from "../../app/settings.js";
import { PendingInputStrip } from "./PendingInputStrip.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import {
  DurableAttachmentCard,
  LocalAttachmentCard,
} from "../../attachments/AttachmentCards.js";
import { useComposerAttachmentUploads } from "../../attachments/useComposerAttachmentUploads.js";
import { AttachmentGroup } from "../ui/attachment.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { ApiError } from "../../api/ApiClient.js";
import {
  ComposerPromptPicker,
  COMPOSER_PROMPT_PICKER_MOBILE_QUERY,
  type ComposerPromptPickerItem,
} from "./ComposerPromptPicker.js";
import { useTaskDrag } from "../../tasks/task-drag.js";
import { OPEN_OVERLAY_SELECTOR } from "../../app/android-back.js";

export const OPEN_PROMPTS_SETTINGS_EVENT = "sedes-open-settings-prompts";

const DRAFT_SAVE_DELAY_MS = 2_000;
const RESTORE_FOCUS_SETTLE_DELAY_MS = 500;
const EMPTY_APPLICATION_STATE = Object.freeze({
  status: "loading" as const,
  connection: "reconnecting" as const,
  authoritative: false,
  search: "",
  visibleThreads: [],
});
const EMPTY_APPLICATION_STORE = {
  subscribe: () => () => undefined,
  getSnapshot: () => EMPTY_APPLICATION_STATE,
  refresh: async () => undefined,
} as unknown as ApplicationClientStore;

type DraftValue = {
  readonly text: string;
  readonly selectedSkillId?: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly attachments: readonly ComposerAttachmentDescriptor[];
  readonly taskReferences: readonly ComposerTaskReference[];
};

type DraftConflictCause =
  | "remote_change"
  | "delivered_merge_limit"
  | "delivery_recovery_merge_limit"
  | "delivery_rollback_skill_conflict"
  | "restore_merge_limit";

type DraftQueueEntry =
  | {
      readonly kind: "save";
      value: DraftValue;
      readonly exact: boolean;
      waiters: Array<{
        resolve: (draft: NormalizedDraft) => void;
        reject: (error: unknown) => void;
      }>;
    }
  | {
      readonly kind: "mutation";
      readonly value: DraftValue;
      readonly run: (draft: NormalizedDraft) => Promise<void>;
      readonly saveWaiters: Array<{
        resolve: (draft: NormalizedDraft) => void;
        reject: (error: unknown) => void;
      }>;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

/**
 * Serializes every operation which consumes or changes the draft revision.
 * Autosaves waiting behind an in-flight operation coalesce to their newest
 * value; mutation barriers are exact and retain their position in the queue.
 */
class DraftOperationQueue {
  readonly #entries: DraftQueueEntry[] = [];
  #running = false;
  #blocked = false;

  constructor(
    private readonly save: (value: DraftValue) => Promise<NormalizedDraft>,
  ) {}

  persist(value: DraftValue, exact: boolean): Promise<NormalizedDraft> {
    return new Promise((resolve, reject) => {
      const tail = this.#entries.at(-1);
      if (!exact && tail?.kind === "save" && !tail.exact) {
        tail.value = value;
        tail.waiters.push({ resolve, reject });
      } else {
        this.#entries.push({
          kind: "save",
          value,
          exact,
          waiters: [{ resolve, reject }],
        });
      }
      void this.#drain();
    });
  }

  mutation(
    value: DraftValue,
    run: (draft: NormalizedDraft) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // An exact mutation snapshot supersedes a waiting debounced autosave.
      // Its callers can share the mutation's save acknowledgement, avoiding
      // an intermediate PUT immediately before send/stash/restore.
      const tail = this.#entries.at(-1);
      let saveWaiters: Array<{
        resolve: (draft: NormalizedDraft) => void;
        reject: (error: unknown) => void;
      }> = [];
      if (tail?.kind === "save" && !tail.exact) {
        this.#entries.pop();
        saveWaiters = tail.waiters;
      }
      this.#entries.push({
        kind: "mutation",
        value,
        run,
        saveWaiters,
        resolve,
        reject,
      });
      void this.#drain();
    });
  }

  setBlocked(blocked: boolean): void {
    if (this.#blocked === blocked) return;
    this.#blocked = blocked;
    if (!blocked) void this.#drain();
  }

  replacePendingAutosave(value: DraftValue): void {
    for (const entry of this.#entries) {
      if (entry.kind === "save" && !entry.exact) entry.value = value;
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#entries.length > 0 && !this.#blocked) {
        const entry = this.#entries.shift()!;
        if (entry.kind === "save") {
          try {
            const saved = await this.save(entry.value);
            for (const waiter of entry.waiters) waiter.resolve(saved);
          } catch (error) {
            for (const waiter of entry.waiters) waiter.reject(error);
          }
          continue;
        }
        try {
          let saved: NormalizedDraft;
          try {
            saved = await this.save(entry.value);
          } catch (error) {
            for (const waiter of entry.saveWaiters) waiter.reject(error);
            throw error;
          }
          for (const waiter of entry.saveWaiters) waiter.resolve(saved);
          await entry.run(saved);
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.#running = false;
      // An entry can be appended between the loop condition and finally.
      if (this.#entries.length > 0 && !this.#blocked) void this.#drain();
    }
  }
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

const terminalPaste = (text: string): string =>
  `${BRACKETED_PASTE_START}${sanitizeTerminalPasteText(text)}${BRACKETED_PASTE_END}`;

const sanitizeTerminalPasteText = (text: string): string =>
  text
    .replaceAll(BRACKETED_PASTE_START, "[200~")
    .replaceAll(BRACKETED_PASTE_END, "[201~");

const terminalPayload = (text: string, mode: "stage" | "submit"): string => {
  const staged = text.trim() ? terminalPaste(text) : "";
  return mode === "submit" ? `${staged}\r` : staged;
};

const terminalPayloadFits = (payload: string): boolean =>
  new TextEncoder().encode(payload).byteLength <= MAXIMUM_CODEX_TUI_INPUT_BYTES;

const resizeComposerTextarea = (element: HTMLTextAreaElement): void => {
  element.style.height = "0";
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
};

export function Composer({
  active = true,
  store,
  applicationStore,
  disabled = false,
  hidePendingInputs = false,
  optimisticTranscriptPresentationVisible = true,
  autoFocus = false,
  onImmediateSend,
}: {
  active?: boolean;
  store: ThreadClientStore;
  applicationStore?: ApplicationClientStore;
  disabled?: boolean;
  hidePendingInputs?: boolean;
  /** True only while Transcript is presenting the authoritative live edge. */
  optimisticTranscriptPresentationVisible?: boolean;
  autoFocus?: boolean;
  /** Arms transcript seek for the exact optimistic idle-submit operation. */
  onImmediateSend?: (operationId: string) => void;
}): React.JSX.Element | null {
  const state = useThreadStore(store);
  const chatViewVisible = useContext(ChatViewVisibilityContext);
  const resolvedApplicationStore = applicationStore ?? EMPTY_APPLICATION_STORE;
  const application = useApplicationStore(resolvedApplicationStore);
  const snapshot = state.snapshot;
  const serverDraft = snapshot?.draft;
  const retainedComposerState = getRetainedComposerDeliveryState(store);
  const shouldVisuallyClearServerDraft = state.pendingComposerTransfers.some(
    (transfer) =>
      transfer.authorityState === "client_only" &&
      !transfer.rollbackRequired &&
      (transfer.mode === "steer" ||
        transfer.requestState === "saving" ||
        transfer.requestState === "requesting"),
  );
  const hasUnconfirmedSteerTransfer = state.pendingComposerTransfers.some(
    (transfer) =>
      transfer.mode === "steer" &&
      transfer.authorityState === "client_only" &&
      transfer.steerPhase === "unconfirmed",
  );
  const initiallyVisibleDraft =
    retainedComposerState?.draft ??
    (shouldVisuallyClearServerDraft && serverDraft
      ? visuallyClearedDraft(serverDraft)
      : serverDraft);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentPickerAdmitted = useRef(false);
  const composerId = useId();
  const stashButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const [stashOpen, setStashOpen] = useState(false);
  const [activeStashIndex, setActiveStashIndex] = useState(0);
  const [preferredDeliveryMode, setPreferredDeliveryMode] = useState<
    "steer" | "queue"
  >(() => {
    try {
      return localStorage.getItem("sedes-composer-delivery-mode") === "queue"
        ? "queue"
        : "steer";
    } catch {
      return "steer";
    }
  });
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedCommandDraft, setDismissedCommandDraft] = useState<string>();
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const skillSearchRef = useRef<HTMLInputElement>(null);
  const skillPickerFocus = usePickerFocus(skillSearchRef);
  const dialogContainer = useContext(DialogPortalContainerContext);
  const [skillQuery, setSkillQuery] = useState("");
  const [skills, setSkills] = useState<readonly ComposerSkillDescriptor[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string>();
  const terminalControl = useContext(CodexTuiTerminalControlContext);
  const composerDraftCoordinator = useComposerDraftCoordinator();
  const taskDrag = useTaskDrag();
  const mobileTerminalLayout = useMediaQuery(MOBILE_TUI_MEDIA_QUERY);
  const mobileComposerLayout = useMediaQuery(
    COMPOSER_PROMPT_PICKER_MOBILE_QUERY,
  );
  const [tuiSubmissionError, setTuiSubmissionError] = useState<string>();
  const [attachmentInputError, setAttachmentInputError] = useState<string>();
  const [promptInputError, setPromptInputError] = useState<string>();
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [taskDragActive, setTaskDragActive] = useState(false);
  useEffect(() => {
    if (taskDrag?.activeTaskId === undefined) setTaskDragActive(false);
  }, [taskDrag?.activeTaskId]);
  const [showPromptsTab, setShowPromptsTab] = useState(getShowPromptsTab);
  const [promptsPlacement, setPromptsPlacementState] =
    useState(getPromptsPlacement);
  const promptStore = applicationStore?.cannedPrompts;
  const [promptState, setPromptState] = useState(() =>
    promptStore?.getSnapshot(),
  );
  // Draft text is composer-local state: keystrokes never write to the
  // thread store, so the transcript and header do not re-render while
  // typing. The text is persisted on a 2s debounce, on unmount (thread
  // switch), and before mutations that need a server-known revision
  // (send / stash / restore / move). `syncedDraft` tracks the last draft
  // the server is known to hold; `lastSavedText` recognizes our own saves'
  // draft_changed echoes so they cannot trip the conflict banner.
  const [text, setText] = useState(initiallyVisibleDraft?.text ?? "");
  const [selectedSkillId, setSelectedSkillId] = useState(
    initiallyVisibleDraft?.selectedSkillId,
  );
  const [contextExcerpts, setContextExcerpts] = useState<ContextExcerpt[]>(
    () => [...(initiallyVisibleDraft?.contextExcerpts ?? [])],
  );
  const [attachments, setAttachments] = useState<
    ComposerAttachmentDescriptor[]
  >(() => [...(initiallyVisibleDraft?.attachments ?? [])]);
  const [taskReferences, setTaskReferences] = useState<ComposerTaskReference[]>(
    () => [...(initiallyVisibleDraft?.taskReferences ?? [])],
  );
  const [dirty, setDirty] = useState(retainedComposerState?.dirty ?? false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [draftConflictCause, setDraftConflictCause] =
    useState<DraftConflictCause>("remote_change");
  const syncedDraft = useRef<NormalizedDraft | undefined>(
    retainedComposerState?.authoritativeBase ?? serverDraft,
  );
  const lastSavedText = useRef<string | undefined>(
    retainedComposerState?.expectedEcho?.text,
  );
  const lastSavedSkillId = useRef<string | undefined>(
    retainedComposerState?.expectedEcho?.selectedSkillId,
  );
  const lastSavedContextExcerpts = useRef<
    readonly ContextExcerpt[] | undefined
  >(retainedComposerState?.expectedEcho?.contextExcerpts);
  const lastSavedAttachments = useRef<
    readonly ComposerAttachmentDescriptor[] | undefined
  >(retainedComposerState?.expectedEcho?.attachments);
  const lastSavedTaskReferences = useRef<
    readonly ComposerTaskReference[] | undefined
  >(retainedComposerState?.expectedEcho?.taskReferences);
  const conflictRef = useRef(false);
  const draftMutationRunning = useRef(false);
  const [draftMutationPending, setDraftMutationPending] = useState(false);
  const queueRestoreRunning = useRef(false);
  const [queueRestorePending, setQueueRestorePending] = useState(false);
  const focusAfterQueueRestore = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // A submitted dictation can commit another composition after refocus.
  // Bound suppression by time, without a timer that could erase a new draft.
  const compositionGuardUntil = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const traceComposerInput = (
    event: Parameters<typeof recordComposerInputDiagnostic>[0],
  ) =>
    recordComposerInputDiagnostic(event, {
      textCharacters: textRef.current.length,
      domTextCharacters: textarea.current?.value.length ?? 0,
      textareaFocused: document.activeElement === textarea.current,
    });
  useEffect(() => {
    const target = textarea.current;
    if (!target) return;
    const eventNames = [
      "focus",
      "blur",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ] as const;
    const observe = (event: Event) => {
      const input = event instanceof InputEvent ? event : undefined;
      recordComposerInputDiagnostic(event.type as (typeof eventNames)[number], {
        textCharacters: textRef.current.length,
        domTextCharacters: target.value.length,
        textareaFocused: document.activeElement === target,
        // Only standardized machine tokens are copied; never event.data.
        inputType:
          input &&
          [
            "insertText",
            "insertReplacementText",
            "insertCompositionText",
            "insertFromComposition",
            "deleteCompositionText",
            "insertLineBreak",
            "insertParagraph",
            "insertFromPaste",
            "insertFromDrop",
            "deleteContentBackward",
            "deleteContentForward",
            "deleteByCut",
            "historyUndo",
            "historyRedo",
          ].includes(input.inputType)
            ? input.inputType
            : "unknown",
        isComposing: input?.isComposing ?? null,
      });
    };
    for (const name of eventNames) target.addEventListener(name, observe);
    return () => {
      for (const name of eventNames) target.removeEventListener(name, observe);
    };
  });
  const selectedSkillIdRef = useRef(selectedSkillId);
  selectedSkillIdRef.current = selectedSkillId;
  const contextExcerptsRef = useRef<readonly ContextExcerpt[]>(contextExcerpts);
  contextExcerptsRef.current = contextExcerpts;
  const attachmentsRef =
    useRef<readonly ComposerAttachmentDescriptor[]>(attachments);
  attachmentsRef.current = attachments;
  const taskReferencesRef =
    useRef<readonly ComposerTaskReference[]>(taskReferences);
  taskReferencesRef.current = taskReferences;
  const excerptSendRef = useRef<(candidate: DraftValue) => boolean>(
    () => false,
  );

  const refreshTasksAfterUnresolvedReference = useCallback(() => {
    void resolvedApplicationStore.refresh().catch(() => undefined);
  }, [resolvedApplicationStore]);

  const uploadAttachment = useCallback(
    (id: string, file: File, signal: AbortSignal) =>
      store.uploadComposerAttachment(id, file, signal),
    [store],
  );
  const loadAttachmentContent = useCallback(
    (id: string, signal: AbortSignal) =>
      store.loadComposerAttachmentContent(id, signal),
    [store],
  );
  const onAttachmentUploaded = useCallback(
    (attachment: ComposerAttachmentDescriptor) => {
      if (attachmentsRef.current.some(({ id }) => id === attachment.id)) {
        return true;
      }
      const next = [...attachmentsRef.current, attachment];
      const parsed = normalizedDraftSchema.safeParse({
        text: textRef.current,
        ...(selectedSkillIdRef.current
          ? { selectedSkillId: selectedSkillIdRef.current }
          : {}),
        contextExcerpts: contextExcerptsRef.current,
        attachments: next,
        taskReferences: taskReferencesRef.current,
        revision: syncedDraft.current?.revision ?? 0,
      });
      if (!parsed.success) {
        setAttachmentInputError(
          parsed.error.issues[0]?.message ??
            "The attachment cannot be added to this prompt.",
        );
        return false;
      }
      attachmentsRef.current = parsed.data.attachments;
      setAttachments(parsed.data.attachments);
      setDirty(true);
      return true;
    },
    [],
  );
  const attachmentUploads = useComposerAttachmentUploads({
    upload: uploadAttachment,
    onUploaded: onAttachmentUploaded,
  });
  const attachmentUploadsRef = useRef(attachmentUploads.uploads);
  attachmentUploadsRef.current = attachmentUploads.uploads;
  const tuiActive = terminalControl?.active === true;
  useEffect(() => subscribeShowPromptsTab(setShowPromptsTab), []);
  useEffect(() => subscribePromptsPlacement(setPromptsPlacementState), []);
  useEffect(() => {
    if (!promptStore) {
      setPromptState(undefined);
      return;
    }
    setPromptState(promptStore.getSnapshot());
    const unsubscribe = promptStore.subscribe(() => {
      setPromptState(promptStore.getSnapshot());
    });
    if (showPromptsTab && !tuiActive) {
      void promptStore.load().catch(() => undefined);
    }
    return unsubscribe;
  }, [promptStore, showPromptsTab, tuiActive]);
  useEffect(() => {
    attachmentUploads.retainLocalFiles(
      new Set(attachments.map(({ id }) => id)),
    );
  }, [attachments, attachmentUploads.retainLocalFiles]);
  const commands = snapshot?.composerCommands ?? [];
  const commandMatches = matchingCommands(text, commands);
  const effectiveActiveCommandIndex = Math.min(
    activeCommandIndex,
    Math.max(0, commandMatches.length - 1),
  );
  const activeCommand = commandMatches[effectiveActiveCommandIndex];
  const commandMenuOpen =
    !disabled &&
    !skillPickerOpen &&
    commandMatches.length > 0 &&
    dismissedCommandDraft !== text;

  const selectedSkill = skills.find(({ id }) => id === selectedSkillId);
  const matchingSkills = skills
    .filter((skill) => {
      const query = skillQuery.trim().toLocaleLowerCase();
      return (
        !query ||
        skill.name.text.toLocaleLowerCase().includes(query) ||
        skill.displayName?.text.toLocaleLowerCase().includes(query) ||
        skill.reference.toLocaleLowerCase().includes(query) ||
        skill.description?.text.toLocaleLowerCase().includes(query)
      );
    })
    .slice(0, 40);

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    setSkillsError(undefined);
    try {
      const catalog = await store.listSkills();
      setSkills(catalog.skills);
    } catch (error) {
      setSkillsError(
        error instanceof Error ? error.message : "Skills are unavailable.",
      );
    } finally {
      setSkillsLoading(false);
    }
  }, [store]);

  const saveDraftValue = useCallback(
    async (value: DraftValue) => {
      const base = syncedDraft.current;
      if (!base) throw new Error("Draft is not loaded.");
      if (conflictRef.current)
        throw new Error("Resolve the draft conflict first.");
      const textToSave = value.text;
      const skillToSave = value.selectedSkillId;
      const excerptsToSave = value.contextExcerpts;
      const attachmentsToSave = value.attachments;
      const taskReferencesToSave = value.taskReferences;
      if (
        textToSave === base.text &&
        skillToSave === base.selectedSkillId &&
        contextExcerptArraysEqual(excerptsToSave, base.contextExcerpts) &&
        attachmentArraysEqual(attachmentsToSave, base.attachments) &&
        taskReferenceArraysEqual(taskReferencesToSave, base.taskReferences)
      ) {
        if (
          textRef.current === base.text &&
          selectedSkillIdRef.current === base.selectedSkillId &&
          contextExcerptArraysEqual(
            contextExcerptsRef.current,
            base.contextExcerpts,
          ) &&
          attachmentArraysEqual(attachmentsRef.current, base.attachments) &&
          taskReferenceArraysEqual(
            taskReferencesRef.current,
            base.taskReferences,
          )
        ) {
          setDirty(false);
        }
        return base;
      }
      try {
        // Pre-mark the expected echo of our own save so it reads as ours even
        // if the draft_changed broadcast beats the PUT response.
        lastSavedText.current = textToSave;
        lastSavedSkillId.current = skillToSave;
        lastSavedContextExcerpts.current = excerptsToSave;
        lastSavedAttachments.current = attachmentsToSave;
        lastSavedTaskReferences.current = taskReferencesToSave;
        const saved = await store.saveDraft({
          text: textToSave,
          ...(skillToSave ? { selectedSkillId: skillToSave } : {}),
          contextExcerpts: [...excerptsToSave],
          attachments: [...attachmentsToSave],
          taskReferences: [...taskReferencesToSave],
          revision: base.revision,
        });
        if (
          !syncedDraft.current ||
          syncedDraft.current.revision <= saved.revision
        ) {
          syncedDraft.current = saved;
          lastSavedText.current = saved.text;
          lastSavedSkillId.current = saved.selectedSkillId;
          lastSavedContextExcerpts.current = saved.contextExcerpts;
          lastSavedAttachments.current = saved.attachments;
          lastSavedTaskReferences.current = saved.taskReferences;
        }
        if (
          taskReferenceIdArraysEqual(
            taskReferencesRef.current,
            taskReferencesToSave,
          ) &&
          taskReferenceIdArraysEqual(saved.taskReferences, taskReferencesToSave)
        ) {
          taskReferencesRef.current = saved.taskReferences;
          setTaskReferences([...saved.taskReferences]);
        }
        // Only the exact saved text counts as clean — the reader may have
        // typed more while the PUT was in flight.
        if (
          textRef.current === textToSave &&
          selectedSkillIdRef.current === skillToSave &&
          contextExcerptArraysEqual(
            contextExcerptsRef.current,
            excerptsToSave,
          ) &&
          attachmentArraysEqual(attachmentsRef.current, attachmentsToSave) &&
          taskReferenceIdArraysEqual(
            taskReferencesRef.current,
            saved.taskReferences,
          )
        ) {
          setDirty(false);
        }
        return saved;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "task_reference_unresolved"
        ) {
          refreshTasksAfterUnresolvedReference();
        } else if ((error as { status?: number } | null)?.status === 409) {
          conflictRef.current = true;
          setDraftConflictCause("remote_change");
          setDraftConflict(true);
        }
        throw error;
      }
    },
    [refreshTasksAfterUnresolvedReference, store],
  );

  const draftQueue = useRef<DraftOperationQueue | undefined>(undefined);
  if (!draftQueue.current) {
    draftQueue.current = new DraftOperationQueue(saveDraftValue);
  }
  const rollbackRestorations = useRef(
    new Map<
      string,
      { readonly before: DraftValue; readonly after: DraftValue }
    >(
      retainedComposerState?.rollbackRestorations.map((restoration) => [
        restoration.operationId,
        {
          before: draftValueFromDraft(restoration.before),
          after: draftValueFromDraft(restoration.after),
        },
      ]),
    ),
  );
  const rollbackProtectionConflicts = useRef(new Set<string>());
  const componentMounted = useRef(true);

  const currentDraftValue = (): DraftValue => ({
    text: textRef.current,
    selectedSkillId: selectedSkillIdRef.current,
    contextExcerpts: contextExcerptsRef.current,
    attachments: attachmentsRef.current,
    taskReferences: taskReferencesRef.current,
  });

  const installComposerValue = (value: DraftValue): void => {
    textRef.current = value.text;
    selectedSkillIdRef.current = value.selectedSkillId;
    contextExcerptsRef.current = value.contextExcerpts;
    attachmentsRef.current = value.attachments;
    taskReferencesRef.current = value.taskReferences;
    setText(value.text);
    setSelectedSkillId(value.selectedSkillId);
    setContextExcerpts([...value.contextExcerpts]);
    setAttachments([...value.attachments]);
    setTaskReferences([...value.taskReferences]);
    const base = syncedDraft.current;
    const nextDirty = !base || !draftValueMatchesDraft(value, base);
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
  };

  const synchronizeRetainedComposerState = (): void => {
    const transfers = store.getSnapshot().pendingComposerTransfers;
    if (
      componentMounted.current &&
      transfers.length === 0 &&
      rollbackRestorations.current.size === 0
    ) {
      clearRetainedComposerDeliveryState(store);
      return;
    }
    const revision = syncedDraft.current?.revision ?? 0;
    setRetainedComposerDeliveryState(store, {
      draft: normalizedDraftFromValue(currentDraftValue(), revision),
      authoritativeBase:
        syncedDraft.current ??
        normalizedDraftFromValue(currentDraftValue(), revision),
      ...(lastSavedText.current !== undefined &&
      lastSavedContextExcerpts.current !== undefined &&
      lastSavedAttachments.current !== undefined &&
      lastSavedTaskReferences.current !== undefined
        ? {
            expectedEcho: normalizedDraftFromValue(
              {
                text: lastSavedText.current,
                selectedSkillId: lastSavedSkillId.current,
                contextExcerpts: lastSavedContextExcerpts.current,
                attachments: lastSavedAttachments.current,
                taskReferences: lastSavedTaskReferences.current,
              },
              revision,
            ),
          }
        : {}),
      dirty: dirtyRef.current,
      rollbackRestorations: [...rollbackRestorations.current].map(
        ([operationId, restoration]) => ({
          operationId,
          before: normalizedDraftFromValue(restoration.before, revision),
          after: normalizedDraftFromValue(restoration.after, revision),
        }),
      ),
    });
  };

  const restoreComposerContribution = (
    operationId: string,
    contribution: DraftValue,
    revision: number,
    limitCause: DraftConflictCause,
  ): boolean => {
    const before = currentDraftValue();
    const merged = mergeComposerContribution(contribution, before, revision);
    if (!merged.ok) {
      conflictRef.current = true;
      setDraftConflictCause(limitCause);
      setDraftConflict(true);
      return false;
    }
    const after: DraftValue = {
      text: merged.draft.text,
      selectedSkillId: merged.draft.selectedSkillId,
      contextExcerpts: merged.draft.contextExcerpts,
      attachments: merged.draft.attachments,
      taskReferences: merged.draft.taskReferences,
    };
    installComposerValue(after);
    draftQueue.current?.replacePendingAutosave(after);
    rollbackRestorations.current.set(operationId, { before, after });
    synchronizeRetainedComposerState();
    if (merged.skillConflict) {
      conflictRef.current = true;
      setDraftConflictCause("delivery_rollback_skill_conflict");
      setDraftConflict(true);
    }
    return true;
  };

  const steerDraftBarrierPending = state.pendingComposerTransfers.some(
    (transfer) =>
      transfer.mode === "steer" &&
      ((transfer.authorityState === "client_only" &&
        transfer.steerPhase === "unconfirmed") ||
        (transfer.rollbackRequired && !transfer.rollbackApplied)),
  );
  useEffect(() => {
    draftQueue.current!.setBlocked(steerDraftBarrierPending);
  }, [steerDraftBarrierPending]);

  useEffect(() => {
    for (const transfer of state.pendingComposerTransfers) {
      if (transfer.rollbackRequired && !transfer.rollbackApplied) {
        if (
          restoreComposerContribution(
            transfer.operationId,
            transfer.captured,
            syncedDraft.current?.revision ?? transfer.captured.revision,
            "delivery_recovery_merge_limit",
          )
        ) {
          if (!transfer.retainTombstoneAfterRollback) {
            rollbackRestorations.current.delete(transfer.operationId);
          }
          store.acknowledgeComposerTransferRollback(transfer.operationId);
          synchronizeRetainedComposerState();
        }
        continue;
      }
      if (!transfer.lateMaterializationRequiresComposerReconciliation) continue;
      const restoration = rollbackRestorations.current.get(
        transfer.operationId,
      );
      if (!restoration) {
        conflictRef.current = true;
        setDraftConflictCause("remote_change");
        setDraftConflict(true);
        store.acknowledgeLateComposerTransferReconciliation(
          transfer.operationId,
        );
        synchronizeRetainedComposerState();
        continue;
      }
      const current = currentDraftValue();
      let ambiguous = false;
      const next: DraftValue = {
        text:
          current.text === restoration.after.text
            ? restoration.before.text
            : ((ambiguous =
                ambiguous ||
                restoration.after.text !== restoration.before.text),
              current.text),
        selectedSkillId:
          current.selectedSkillId === restoration.after.selectedSkillId
            ? restoration.before.selectedSkillId
            : ((ambiguous =
                ambiguous ||
                restoration.after.selectedSkillId !==
                  restoration.before.selectedSkillId),
              current.selectedSkillId),
        contextExcerpts: subtractRestoredContextExcerpts(
          current.contextExcerpts,
          restoration.before.contextExcerpts,
          restoration.after.contextExcerpts,
          () => {
            ambiguous = true;
          },
        ),
        attachments: subtractRestoredAttachments(
          current.attachments,
          restoration.before.attachments,
          restoration.after.attachments,
          () => {
            ambiguous = true;
          },
        ),
        taskReferences: subtractRestoredTaskReferences(
          current.taskReferences,
          restoration.before.taskReferences,
          restoration.after.taskReferences,
          () => {
            ambiguous = true;
          },
        ),
      };
      installComposerValue(next);
      rollbackRestorations.current.delete(transfer.operationId);
      const wasRollbackProtectionConflict =
        rollbackProtectionConflicts.current.delete(transfer.operationId);
      if (ambiguous) {
        conflictRef.current = true;
        setDraftConflictCause("remote_change");
        setDraftConflict(true);
      } else if (
        wasRollbackProtectionConflict &&
        rollbackProtectionConflicts.current.size === 0 &&
        serverDraft &&
        draftValueMatchesDraft(next, serverDraft)
      ) {
        // Exact materialization proves that the newer draft which triggered
        // this operation's protection conflict is now the expected authority.
        // Edited inverses and conflicts from any other path remain surfaced.
        syncedDraft.current = serverDraft;
        dirtyRef.current = false;
        setDirty(false);
        conflictRef.current = false;
        setDraftConflict(false);
      }
      store.acknowledgeLateComposerTransferReconciliation(transfer.operationId);
      synchronizeRetainedComposerState();
    }
  }, [state.pendingComposerTransfers, store]);

  const persistDraft = useCallback(
    (exact = true): Promise<NormalizedDraft | undefined> => {
      const base = syncedDraft.current;
      if (!base) return Promise.resolve(undefined);
      const value = {
        text: textRef.current,
        selectedSkillId: selectedSkillIdRef.current,
        contextExcerpts: contextExcerptsRef.current,
        attachments: attachmentsRef.current,
        taskReferences: taskReferencesRef.current,
      };
      if (
        !dirtyRef.current &&
        value.text === base.text &&
        value.selectedSkillId === base.selectedSkillId &&
        contextExcerptArraysEqual(
          value.contextExcerpts,
          base.contextExcerpts,
        ) &&
        attachmentArraysEqual(value.attachments, base.attachments) &&
        taskReferenceArraysEqual(value.taskReferences, base.taskReferences)
      ) {
        return Promise.resolve(base);
      }
      return draftQueue.current!.persist(value, exact);
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const focusComposerOnRightOption = (event: KeyboardEvent) => {
      if (!getRightOptionFocusesComposer() || event.repeat) return;
      const isRightOption =
        event.key === "AltGraph" ||
        (event.key === "Alt" &&
          event.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT) ||
        event.code === "AltRight";
      if (!isRightOption) return;
      const element = textarea.current;
      if (!element || element.disabled || document.activeElement === element) {
        return;
      }
      event.preventDefault();
      element.focus();
    };
    window.addEventListener("keydown", focusComposerOnRightOption, true);
    return () =>
      window.removeEventListener("keydown", focusComposerOnRightOption, true);
  }, [active]);

  // Debounced autosave. Silent on success; failures surface through the
  // store's actionError (and 409 through the conflict banner).
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void persistDraft(false).catch(() => undefined);
    }, DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    dirty,
    text,
    selectedSkillId,
    contextExcerpts,
    attachments,
    taskReferences,
    persistDraft,
  ]);

  useEffect(() => {
    if (skillPickerOpen || selectedSkillId) void loadSkills();
  }, [skillPickerOpen, selectedSkillId, loadSkills]);

  useEffect(() => {
    const query = skillTriggerQuery(text);
    if (query === undefined) return;
    skillPickerFocus.requestSearchFocus();
    setSkillQuery(query);
    setSkillPickerOpen(true);
  }, [text]);

  // Flush on unmount (covers thread switches), and let the store preflight
  // operations that must not strand unsaved text (move_draft).
  useEffect(() => {
    const flushBeforeExternalMutation = () => {
      if (attachmentUploadsRef.current.length > 0) {
        return Promise.reject(
          new Error(
            "Wait for attachment uploads to finish or remove them before moving this draft.",
          ),
        );
      }
      return persistDraft();
    };
    const unregister = store.registerDraftFlush(flushBeforeExternalMutation);
    return () => {
      unregister();
      componentMounted.current = false;
      const transfers = store.getSnapshot().pendingComposerTransfers;
      if (transfers.length > 0 || rollbackRestorations.current.size > 0) {
        synchronizeRetainedComposerState();
      } else {
        clearRetainedComposerDeliveryState(store);
      }
      const blockedBySteer = transfers.some(
        (transfer) =>
          transfer.mode === "steer" &&
          ((transfer.authorityState === "client_only" &&
            transfer.steerPhase === "unconfirmed") ||
            (transfer.rollbackRequired && !transfer.rollbackApplied)),
      );
      if (dirtyRef.current && !blockedBySteer) {
        void persistDraft().catch(() => undefined);
      }
    };
  }, [store, persistDraft]);

  // Server-side draft changes: adopt while clean (initial load, post-send
  // clears, remote edits with no local typing); while dirty, an echo of our
  // own save just advances the base revision, and any other remote change
  // surfaces the conflict banner.
  useEffect(() => {
    if (!serverDraft) return;
    const base = syncedDraft.current;
    // Stale echoes (older than the revision we already hold — e.g. the
    // pre-resolution snapshot right after a keep-mine save) are ignored.
    if (base && serverDraft.revision < base.revision) return;
    if (
      base &&
      serverDraft.revision === base.revision &&
      serverDraft.text === base.text &&
      serverDraft.selectedSkillId === base.selectedSkillId &&
      contextExcerptArraysEqual(
        serverDraft.contextExcerpts,
        base.contextExcerpts,
      ) &&
      attachmentArraysEqual(serverDraft.attachments, base.attachments) &&
      taskReferenceArraysEqual(serverDraft.taskReferences, base.taskReferences)
    ) {
      return;
    }
    const protectedRollbackTransfer = state.pendingComposerTransfers.find(
      (transfer) =>
        transfer.authorityState === "rolled_back_tombstone" &&
        transfer.retainTombstoneAfterRollback &&
        rollbackRestorations.current.has(transfer.operationId),
    );
    if (
      !protectedRollbackTransfer &&
      serverDraft.text === lastSavedText.current &&
      serverDraft.selectedSkillId === lastSavedSkillId.current &&
      lastSavedContextExcerpts.current !== undefined &&
      contextExcerptArraysEqual(
        serverDraft.contextExcerpts,
        lastSavedContextExcerpts.current,
      ) &&
      lastSavedAttachments.current !== undefined &&
      attachmentArraysEqual(
        serverDraft.attachments,
        lastSavedAttachments.current,
      ) &&
      lastSavedTaskReferences.current !== undefined &&
      taskReferenceIdArraysEqual(
        serverDraft.taskReferences,
        lastSavedTaskReferences.current,
      )
    ) {
      syncedDraft.current = serverDraft;
      if (
        taskReferenceIdArraysEqual(
          taskReferencesRef.current,
          lastSavedTaskReferences.current,
        )
      ) {
        taskReferencesRef.current = serverDraft.taskReferences;
        setTaskReferences([...serverDraft.taskReferences]);
      }
      lastSavedTaskReferences.current = serverDraft.taskReferences;
      return;
    }
    if (
      ((retainedComposerState && shouldVisuallyClearServerDraft) ||
        protectedRollbackTransfer !== undefined) &&
      !dirtyRef.current &&
      !draftConflict &&
      base &&
      !draftValueMatchesDraft(draftValueFromDraft(serverDraft), base)
    ) {
      // An unresolved transfer may hide the same provider-retained draft, or
      // an ambiguous Submit rollback may happen to equal the previous sync
      // base. Different authority at a newer revision cannot clean-adopt over
      // either protected value before exact transfer correlation resolves it.
      if (protectedRollbackTransfer) {
        rollbackProtectionConflicts.current.add(
          protectedRollbackTransfer.operationId,
        );
      }
      conflictRef.current = true;
      setDraftConflictCause("remote_change");
      setDraftConflict(true);
      return;
    }
    if (!dirtyRef.current && !draftConflict) {
      syncedDraft.current = serverDraft;
      lastSavedText.current = undefined;
      lastSavedSkillId.current = undefined;
      lastSavedContextExcerpts.current = undefined;
      lastSavedAttachments.current = undefined;
      lastSavedTaskReferences.current = undefined;
      const visible = shouldVisuallyClearServerDraft
        ? visuallyClearedDraft(serverDraft)
        : serverDraft;
      setText(visible.text);
      setSelectedSkillId(visible.selectedSkillId);
      setContextExcerpts([...visible.contextExcerpts]);
      setAttachments([...visible.attachments]);
      setTaskReferences([...visible.taskReferences]);
      return;
    }
    if (protectedRollbackTransfer) {
      rollbackProtectionConflicts.current.add(
        protectedRollbackTransfer.operationId,
      );
    }
    conflictRef.current = true;
    setDraftConflictCause("remote_change");
    setDraftConflict(true);
  }, [
    serverDraft,
    draftConflict,
    shouldVisuallyClearServerDraft,
    state.pendingComposerTransfers,
  ]);
  const busy = snapshot
    ? [
        "starting",
        "running",
        "waiting_for_approval",
        "waiting_for_input",
        "stopping",
      ].includes(snapshot.runState)
    : false;
  const capabilitiesPending =
    state.connection === "connected" && store.awaitingRunStateCapabilities;
  // A sent message is on its way before the server publishes its run state.
  // Show activity from Send until authoritative state takes over; this is
  // presentation only and does not change delivery modes or controls.
  const submitInFlight = state.pendingComposerTransfers.some(
    (transfer) =>
      transfer.presentation === "transcript" &&
      transfer.authorityState === "client_only" &&
      !transfer.rollbackRequired &&
      transfer.requestState !== "request_failed",
  );
  const showLiveActivityBar =
    (busy || submitInFlight) && state.connection === "connected" &&
    (state.authoritative || capabilitiesPending);
  const supportedBusyDeliveryModes =
    snapshot?.capabilities.deliveryModes.filter(
      ({ id }) => id === "steer" || id === "queue",
    ) ?? [];
  // Presence means support; availability only describes the current turn.
  // A backend-specific effective choice must not overwrite the user's preference.
  const deliveryMode = supportedBusyDeliveryModes.some(
    ({ id }) => id === preferredDeliveryMode,
  )
    ? preferredDeliveryMode
    : (supportedBusyDeliveryModes[0]?.id ?? preferredDeliveryMode);
  const availableDeliveryModes =
    snapshot?.capabilities.deliveryModes.filter(({ available }) => available) ??
    [];
  const currentTasks = new Map(
    (application.snapshot?.tasks ?? []).map((task) => [task.id, task]),
  );
  const taskProjectionChecking = !application.authoritative;
  const missingTaskReferences = taskProjectionChecking
    ? []
    : taskReferences.filter(({ taskId }) => !currentTasks.has(taskId));
  const effectiveDisabled =
    disabled ||
    !snapshot ||
    !state.authoritative ||
    state.connection !== "connected";
  // Local typing needs no mutation authority. Preserve focus across the live
  // run-state/capability handoff while Send, Stop and other actions stay fenced.
  const draftEditingDisabled =
    disabled || !snapshot || state.connection !== "connected" ||
    (!state.authoritative && !capabilitiesPending);
  useEffect(() => {
    if (
      !active ||
      effectiveDisabled ||
      queueRestorePending ||
      !focusAfterQueueRestore.current
    ) {
      return;
    }
    let settled: number | undefined;
    const frame = requestAnimationFrame(() => {
      const target = textarea.current;
      if (!target || target.disabled) return;
      if (
        document.activeElement !== document.body &&
        document.activeElement !== target
      ) {
        focusAfterQueueRestore.current = false;
        return;
      }
      target.focus();
      // The receipt can precede its already-published replacement snapshot.
      // Keep the intent armed across that short authority handoff so disabling
      // the textarea cannot permanently discard the successful action's focus.
      settled = window.setTimeout(() => {
        if (!target.disabled) focusAfterQueueRestore.current = false;
      }, RESTORE_FOCUS_SETTLE_DELAY_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (settled !== undefined) window.clearTimeout(settled);
    };
  }, [active, effectiveDisabled, queueRestorePending]);
  const hasStashableDraft = Boolean(
    text.trim() ||
    selectedSkillId ||
    contextExcerpts.length ||
    attachments.length ||
    taskReferences.length,
  );
  const hasDeliverableInput = hasDeliverableComposerInput({
    text,
    selectedSkillId,
    contextExcerpts,
    attachments,
    taskReferences,
  });
  const attachmentUploadPending = attachmentUploads.uploads.length > 0;
  const promptDeliveryMode = busy ? deliveryMode : "submit";
  const promptSendDisabled =
    state.actionPending ||
    state.pendingDeliveryThreadRevision !== undefined ||
    hasUnconfirmedSteerTransfer ||
    missingTaskReferences.length > 0 ||
    snapshot?.runState === "stopping" ||
    !availableDeliveryModes.some(
      ({ id, available }) => available && id === promptDeliveryMode,
    );
  const canDeliver = (
    mode: "submit" | "steer" | "queue",
    candidate?: DraftValue,
  ) => {
    const candidateHasDeliverableInput = candidate
      ? hasDeliverableComposerInput(candidate)
      : hasDeliverableInput;
    if (
      effectiveDisabled ||
      state.actionPending ||
      state.pendingDeliveryThreadRevision !== undefined ||
      hasUnconfirmedSteerTransfer ||
      draftMutationPending ||
      attachmentUploadPending ||
      missingTaskReferences.length > 0 ||
      !candidateHasDeliverableInput ||
      snapshot.runState === "stopping"
    ) {
      return false;
    }
    return availableDeliveryModes.some(
      ({ id, available }) => available && id === mode,
    );
  };

  const contextExcerptStagingSnapshot =
    useCallback((): ContextExcerptStagingSnapshot => {
      if (effectiveDisabled) {
        return {
          available: false,
          reason: "The message composer is unavailable.",
        };
      }
      if (draftConflict) {
        return {
          available: false,
          reason: "Resolve the draft conflict first.",
        };
      }
      if (queueRestorePending) {
        return {
          available: false,
          reason: "Wait for the current composer action to finish.",
        };
      }
      return { available: true, deliveryMode: promptDeliveryMode };
    }, [draftConflict, effectiveDisabled, queueRestorePending, promptDeliveryMode]);

  const stageContextExcerpt = useCallback(
    (excerpt: ContextExcerpt) => {
      if (queueRestoreRunning.current) {
        return {
          ok: false as const,
          reason: "Wait for the current composer action to finish.",
        };
      }
      const availability = contextExcerptStagingSnapshot();
      if (!availability.available) {
        return {
          ok: false as const,
          reason: availability.reason ?? "The message composer is unavailable.",
        };
      }
      const current = contextExcerptsRef.current;
      if (current.some((candidate) => candidate.id === excerpt.id)) {
        return {
          ok: false as const,
          reason: "That excerpt is already attached.",
        };
      }
      const next = [...current, excerpt];
      const parsed = normalizedDraftSchema.safeParse({
        text: textRef.current,
        ...(selectedSkillIdRef.current
          ? { selectedSkillId: selectedSkillIdRef.current }
          : {}),
        contextExcerpts: next,
        attachments: attachmentsRef.current,
        taskReferences: taskReferencesRef.current,
        revision: syncedDraft.current?.revision ?? 0,
      });
      if (!parsed.success) {
        return {
          ok: false as const,
          reason:
            parsed.error.issues[0]?.message ??
            "The excerpt cannot be attached.",
        };
      }
      contextExcerptsRef.current = parsed.data.contextExcerpts;
      setContextExcerpts(parsed.data.contextExcerpts);
      setDirty(true);
      return { ok: true as const };
    },
    [contextExcerptStagingSnapshot],
  );

  const stageTaskReference = useCallback(
    (reference: ComposerTaskReference) => {
      if (queueRestoreRunning.current) {
        return {
          ok: false as const,
          reason: "Wait for the current composer action to finish.",
        };
      }
      const availability = contextExcerptStagingSnapshot();
      if (!availability.available) {
        return {
          ok: false as const,
          reason: availability.reason ?? "The message composer is unavailable.",
        };
      }
      if (
        taskReferencesRef.current.some(
          ({ taskId }) => taskId === reference.taskId,
        )
      ) {
        return { ok: false as const, reason: "That task is already attached." };
      }
      const parsed = normalizedDraftSchema.safeParse({
        text: textRef.current,
        ...(selectedSkillIdRef.current
          ? { selectedSkillId: selectedSkillIdRef.current }
          : {}),
        contextExcerpts: contextExcerptsRef.current,
        attachments: attachmentsRef.current,
        taskReferences: [...taskReferencesRef.current, reference],
        revision: syncedDraft.current?.revision ?? 0,
      });
      if (!parsed.success) {
        return {
          ok: false as const,
          reason:
            parsed.error.issues[0]?.message ?? "The task cannot be attached.",
        };
      }
      taskReferencesRef.current = parsed.data.taskReferences;
      setTaskReferences(parsed.data.taskReferences);
      setDirty(true);
      requestAnimationFrame(() => textarea.current?.focus());
      return { ok: true as const };
    },
    [contextExcerptStagingSnapshot],
  );

  const unstageTaskReference = useCallback((taskId: string): boolean => {
    if (queueRestoreRunning.current) return false;
    if (!taskReferencesRef.current.some((item) => item.taskId === taskId)) {
      return false;
    }
    const next = taskReferencesRef.current.filter(
      (item) => item.taskId !== taskId,
    );
    taskReferencesRef.current = next;
    setTaskReferences([...next]);
    setDirty(true);
    requestAnimationFrame(() => textarea.current?.focus());
    return true;
  }, []);

  const excerptDeliveryAvailable = availableDeliveryModes.some(
    ({ id, available }) => available && id === promptDeliveryMode,
  );
  const excerptSendUnavailableReason = useCallback(
    (candidate: DraftValue): string | undefined => {
      if (tuiActive) return "Switch to Chat before sending this note.";
      if (effectiveDisabled) return "The message composer is unavailable.";
      if (draftConflict) return "Resolve the draft conflict first.";
      if (
        state.actionPending ||
        state.pendingDeliveryThreadRevision !== undefined ||
        hasUnconfirmedSteerTransfer ||
        draftMutationPending ||
        draftMutationRunning.current ||
        queueRestorePending ||
        queueRestoreRunning.current
      ) {
        return "Wait for the current composer action to finish.";
      }
      if (attachmentUploadPending) {
        return "Wait for attachment uploads to finish before sending.";
      }
      if (missingTaskReferences.length > 0) {
        return "Remove the missing task before sending.";
      }
      if (!hasDeliverableComposerInput(candidate)) {
        return "Add a note before sending this excerpt immediately.";
      }
      if (!excerptDeliveryAvailable || snapshot?.runState === "stopping") {
        return "The composer’s current send action is unavailable for this thread.";
      }
      return undefined;
    },
    [
      attachmentUploadPending,
      snapshot?.runState,
      draftConflict,
      draftMutationPending,
      effectiveDisabled,
      hasUnconfirmedSteerTransfer,
      missingTaskReferences.length,
      queueRestorePending,
      state.actionPending,
      state.pendingDeliveryThreadRevision,
      excerptDeliveryAvailable,
      tuiActive,
    ],
  );

  const attachAndSubmitContextExcerpt = useCallback(
    (
      excerpt: ContextExcerpt,
    ):
      | { readonly ok: true }
      | { readonly ok: false; readonly reason: string } => {
      if (queueRestoreRunning.current) {
        return {
          ok: false,
          reason: "Wait for the current composer action to finish.",
        };
      }
      const availability = contextExcerptStagingSnapshot();
      if (!availability.available) {
        return {
          ok: false,
          reason: availability.reason ?? "The message composer is unavailable.",
        };
      }
      const current = contextExcerptsRef.current;
      if (current.some((candidate) => candidate.id === excerpt.id)) {
        return { ok: false, reason: "That excerpt is already attached." };
      }
      const parsed = normalizedDraftSchema.safeParse({
        text: textRef.current,
        ...(selectedSkillIdRef.current
          ? { selectedSkillId: selectedSkillIdRef.current }
          : {}),
        contextExcerpts: [...current, excerpt],
        attachments: attachmentsRef.current,
        taskReferences: taskReferencesRef.current,
        revision: syncedDraft.current?.revision ?? 0,
      });
      if (!parsed.success) {
        return {
          ok: false,
          reason:
            parsed.error.issues[0]?.message ??
            "The excerpt cannot be attached.",
        };
      }
      const candidate = draftValueFromDraft(parsed.data);
      const unavailableReason = excerptSendUnavailableReason(candidate);
      if (unavailableReason) return { ok: false, reason: unavailableReason };
      return excerptSendRef.current(candidate)
        ? { ok: true }
        : {
            ok: false,
            reason:
              "The message could not be sent. The selection is still available.",
          };
    },
    [contextExcerptStagingSnapshot, excerptSendUnavailableReason],
  );

  useEffect(() => {
    if (!composerDraftCoordinator) return undefined;
    return composerDraftCoordinator.registerConsumer({
      stage: stageContextExcerpt,
      attachAndSubmit: attachAndSubmitContextExcerpt,
      stageTaskReference,
      getSnapshot: contextExcerptStagingSnapshot,
    });
  }, [
    composerDraftCoordinator,
    contextExcerptStagingSnapshot,
    stageContextExcerpt,
    stageTaskReference,
    attachAndSubmitContextExcerpt,
  ]);

  useEffect(() => {
    composerDraftCoordinator?.notify();
  }, [
    composerDraftCoordinator,
    draftConflict,
    draftMutationPending,
    effectiveDisabled,
  ]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    resizeComposerTextarea(element);
  }, [text]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let measuredWidth = element.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      // Updating the height can itself deliver another ResizeObserver entry.
      // Only width changes can alter line wrapping, so ignore height-only
      // notifications and avoid an observer feedback loop.
      if (Math.abs(width - measuredWidth) < 0.5) return;
      measuredWidth = width;
      resizeComposerTextarea(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!stashOpen) return;
    setActiveStashIndex(0);
    requestAnimationFrame(() => stashButtons.current[0]?.focus());
  }, [stashOpen, state.stashes.length]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [text, commands]);

  useEffect(() => {
    if (!terminalControl?.active) {
      setTuiSubmissionError(undefined);
    }
  }, [terminalControl?.active]);

  if (!snapshot) return null;

  const showKeyBar = tuiActive && mobileTerminalLayout;
  const tuiInputAvailable = tuiActive && terminalControl.inputAvailable;
  const tuiStructuredInputReason =
    contextExcerpts.length > 0
      ? "Switch to Chat to send context excerpts."
      : attachments.length > 0 || attachmentUploadPending
        ? "Switch to Chat to send attachments."
        : taskReferences.length > 0
          ? "Switch to Chat to send Task references."
          : selectedSkillId && !selectedSkill
            ? "Wait for the selected skill to finish loading."
            : undefined;
  const tuiTerminalText = selectedSkill
    ? `${selectedSkill.reference}${text.trim() ? ` ${text}` : ""}`
    : text;
  const tuiSizeReason = terminalPayloadFits(
    terminalPayload(tuiTerminalText, "submit"),
  )
    ? undefined
    : "The TUI accepts at most 64 KiB per composer submission. Shorten the draft or switch to Chat.";
  const tuiComposerNoticeReason = tuiStructuredInputReason ?? tuiSizeReason;
  const tuiSubmitUnavailableReason = !tuiInputAvailable
    ? "The TUI is not ready for input."
    : effectiveDisabled
      ? "The composer is unavailable."
      : draftConflict
        ? "Resolve the draft conflict before sending to the TUI."
        : draftMutationPending || queueRestorePending
          ? "Wait for the current draft operation to finish."
          : tuiComposerNoticeReason;
  const canSubmitToTui = tuiActive && !tuiSubmitUnavailableReason;
  const canStageToTui =
    canSubmitToTui && Boolean(text.trim() || selectedSkillId);

  const useLatestDraft = () => {
    if (!serverDraft) return;
    for (const upload of attachmentUploads.uploads) {
      attachmentUploads.remove(upload.id);
    }
    syncedDraft.current = serverDraft;
    lastSavedText.current = undefined;
    lastSavedSkillId.current = undefined;
    lastSavedContextExcerpts.current = undefined;
    lastSavedAttachments.current = undefined;
    lastSavedTaskReferences.current = undefined;
    setText(serverDraft.text);
    setSelectedSkillId(serverDraft.selectedSkillId);
    setContextExcerpts([...serverDraft.contextExcerpts]);
    attachmentsRef.current = serverDraft.attachments;
    setAttachments([...serverDraft.attachments]);
    setTaskReferences([...serverDraft.taskReferences]);
    setDirty(false);
    conflictRef.current = false;
    setDraftConflictCause("remote_change");
    setDraftConflict(false);
  };

  const keepMineDraft = async () => {
    if (!serverDraft) return;
    conflictRef.current = false;
    // Pre-mark the expected echo of our own save so it reads as ours even
    // if it arrives on the stream before the PUT resolves.
    lastSavedText.current = textRef.current;
    lastSavedSkillId.current = selectedSkillIdRef.current;
    lastSavedContextExcerpts.current = contextExcerptsRef.current;
    lastSavedAttachments.current = attachmentsRef.current;
    lastSavedTaskReferences.current = taskReferencesRef.current;
    syncedDraft.current = serverDraft;
    let saved: NormalizedDraft;
    try {
      saved = await draftQueue.current!.persist(
        {
          text: textRef.current,
          selectedSkillId: selectedSkillIdRef.current,
          contextExcerpts: contextExcerptsRef.current,
          attachments: attachmentsRef.current,
          taskReferences: taskReferencesRef.current,
        },
        true,
      );
    } catch (error) {
      conflictRef.current = true;
      throw error;
    }
    syncedDraft.current = saved;
    lastSavedText.current = saved.text;
    lastSavedSkillId.current = saved.selectedSkillId;
    lastSavedContextExcerpts.current = saved.contextExcerpts;
    lastSavedAttachments.current = saved.attachments;
    lastSavedTaskReferences.current = saved.taskReferences;
    // Only the exact saved text counts as clean — anything typed while the
    // PUT was in flight still needs the autosave.
    if (
      textRef.current === saved.text &&
      selectedSkillIdRef.current === saved.selectedSkillId &&
      contextExcerptArraysEqual(
        contextExcerptsRef.current,
        saved.contextExcerpts,
      ) &&
      attachmentArraysEqual(attachmentsRef.current, saved.attachments) &&
      taskReferenceArraysEqual(taskReferencesRef.current, saved.taskReferences)
    ) {
      setDirty(false);
    }
    setDraftConflict(false);
    setDraftConflictCause("remote_change");
  };

  const stash = async () => {
    if (attachmentUploadPending) return;
    if (!hasStashableDraft) {
      setStashOpen(true);
      return;
    }
    if (draftMutationRunning.current) return;
    draftMutationRunning.current = true;
    setDraftMutationPending(true);
    const value = {
      text: textRef.current,
      selectedSkillId: selectedSkillIdRef.current,
      contextExcerpts: contextExcerptsRef.current,
      attachments: attachmentsRef.current,
      taskReferences: taskReferencesRef.current,
    };
    try {
      await draftQueue.current!.mutation(value, async (persisted) => {
        // Pre-mark the expected post-stash empty-draft echo so it reads as our
        // own even if it arrives before the stash response resolves.
        lastSavedText.current = "";
        lastSavedSkillId.current = undefined;
        lastSavedContextExcerpts.current = [];
        lastSavedAttachments.current = [];
        lastSavedTaskReferences.current = [];
        const result = await store.stash(persisted);
        if (
          !syncedDraft.current ||
          syncedDraft.current.revision <= result.revision
        ) {
          syncedDraft.current = result;
          lastSavedText.current = result.text;
          lastSavedSkillId.current = result.selectedSkillId;
          lastSavedContextExcerpts.current = result.contextExcerpts;
          lastSavedAttachments.current = result.attachments;
          lastSavedTaskReferences.current = result.taskReferences;
        }
        // Clear each field only when that field still matches what was
        // stashed. Context gathered while the request is in flight belongs to
        // the next draft and must survive without retaining the old text.
        const textChanged = textRef.current !== persisted.text;
        const skillChanged =
          selectedSkillIdRef.current !== persisted.selectedSkillId;
        const remainingExcerpts = contextExcerptRemainder(
          contextExcerptsRef.current,
          persisted.contextExcerpts,
        );
        const remainingAttachments = attachmentRemainder(
          attachmentsRef.current,
          persisted.attachments,
        );
        const remainingTaskReferences = taskReferenceRemainder(
          taskReferencesRef.current,
          persisted.taskReferences,
        );
        if (!textChanged) setText(result.text);
        if (!skillChanged) setSelectedSkillId(result.selectedSkillId);
        contextExcerptsRef.current = remainingExcerpts;
        setContextExcerpts(remainingExcerpts);
        attachmentsRef.current = remainingAttachments;
        setAttachments(remainingAttachments);
        taskReferencesRef.current = remainingTaskReferences;
        setTaskReferences(remainingTaskReferences);
        setDirty(
          textChanged ||
            skillChanged ||
            remainingExcerpts.length > 0 ||
            remainingAttachments.length > 0 ||
            remainingTaskReferences.length > 0,
        );
      });
      textarea.current?.focus();
    } finally {
      draftMutationRunning.current = false;
      setDraftMutationPending(false);
    }
  };

  const writeDraftToTerminal = (mode: "stage" | "submit") => {
    if (
      !terminalControl?.active ||
      !canSubmitToTui ||
      draftMutationRunning.current ||
      (mode === "stage" && !canStageToTui)
    ) {
      return;
    }
    const value = currentDraftValue();
    const terminalText = selectedSkill
      ? `${selectedSkill.reference}${value.text.trim() ? ` ${value.text}` : ""}`
      : value.text;
    const capturedDraftHasContent = Boolean(
      value.text || value.selectedSkillId,
    );
    const payload = terminalPayload(terminalText, mode);
    if (!terminalPayloadFits(payload)) {
      setTuiSubmissionError(
        "The TUI accepts at most 64 KiB per composer submission. Shorten the draft or switch to Chat.",
      );
      return;
    }
    if (!terminalControl.sendKey(payload)) {
      setTuiSubmissionError(
        "The TUI did not accept the input. Your draft was kept.",
      );
      return;
    }
    setTuiSubmissionError(undefined);

    if (!capturedDraftHasContent) return;

    const cleared: DraftValue = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
    };
    flushSync(() => {
      textRef.current = "";
      selectedSkillIdRef.current = undefined;
      dirtyRef.current = false;
      setText("");
      setSelectedSkillId(undefined);
      setDirty(false);
    });
    textarea.current?.focus();
    draftMutationRunning.current = true;
    setDraftMutationPending(true);
    const restorationId = `tui-${crypto.randomUUID()}`;
    void draftQueue
      .current!.mutation(value, async () => {
        const authoritative = await saveDraftValue(cleared);
        const nextDirty = !draftValueMatchesDraft(
          currentDraftValue(),
          authoritative,
        );
        dirtyRef.current = nextDirty;
        setDirty(nextDirty);
      })
      .catch(() => {
        restoreComposerContribution(
          restorationId,
          value,
          syncedDraft.current?.revision ?? 0,
          "remote_change",
        );
        rollbackRestorations.current.delete(restorationId);
        synchronizeRetainedComposerState();
        setTuiSubmissionError(
          "Input reached the TUI, but Sedes could not clear the draft. Review it before sending again.",
        );
      })
      .finally(() => {
        draftMutationRunning.current = false;
        setDraftMutationPending(false);
      });
  };

  const send = (
    candidate?: DraftValue,
    requestedMode?: "submit" | "steer" | "queue",
  ): boolean => {
    if (tuiActive) {
      if (requestedMode) return false;
      writeDraftToTerminal("submit");
      return true;
    }
    const mode = requestedMode ?? (busy ? deliveryMode : "submit");
    const value = candidate ?? currentDraftValue();
    if (!canDeliver(mode, value) || draftMutationRunning.current) return false;
    recordComposerInputDiagnostic("send_captured", {
      textCharacters: value.text.length,
      domTextCharacters: textarea.current?.value.length ?? 0,
      textareaFocused: document.activeElement === textarea.current,
      refocusEnabled:
        !mobileTerminalLayout || getMobileComposerRefocusAfterSend(),
      mode,
    });
    const operationId = crypto.randomUUID();
    const capturedDraft: NormalizedDraft = {
      text: value.text,
      ...(value.selectedSkillId
        ? { selectedSkillId: value.selectedSkillId }
        : {}),
      contextExcerpts: [...value.contextExcerpts],
      attachments: [...value.attachments],
      taskReferences: [...value.taskReferences],
      revision: syncedDraft.current?.revision ?? 0,
    };
    // Publishing the destination and clearing every captured field inside one
    // flush prevents useSyncExternalStore from exposing an intermediate frame
    // with the pending row/bubble and its source still in the composer.
    compositionGuardUntil.current = performance.now() + 250;
    flushSync(() => {
      store.stageComposerTransfer(operationId, mode, capturedDraft, {
        ...(selectedSkill
          ? {
              selectedSkillLabel:
                selectedSkill.displayName?.text ??
                selectedSkill.name.text ??
                selectedSkill.reference,
            }
          : value.selectedSkillId
            ? { selectedSkillLabel: "Skill selected" }
            : {}),
      });
      textRef.current = "";
      selectedSkillIdRef.current = undefined;
      contextExcerptsRef.current = [];
      attachmentsRef.current = [];
      taskReferencesRef.current = [];
      dirtyRef.current = false;
      setText("");
      setSelectedSkillId(undefined);
      setContextExcerpts([]);
      setAttachments([]);
      setTaskReferences([]);
      setDirty(false);
      if (mode === "submit") onImmediateSend?.(operationId);
    });
    traceComposerInput("send_cleared");
    if (!mobileTerminalLayout || getMobileComposerRefocusAfterSend()) {
      traceComposerInput("send_refocus");
      textarea.current?.focus();
    }
    draftMutationRunning.current = true;
    setDraftMutationPending(true);
    let deliveryStarted = false;
    let rollbackHandled = false;
    void (async () => {
      await draftQueue.current!.mutation(value, async (persisted) => {
        // Most delivery receipts clear the draft. Pre-mark that expected echo
        // so it does not look like a remote write while the request is active.
        // A recovery receipt may instead retain the draft; its exact state is
        // installed below before the mutation leaves this queue barrier.
        lastSavedText.current = "";
        lastSavedSkillId.current = undefined;
        lastSavedContextExcerpts.current = [];
        lastSavedAttachments.current = [];
        lastSavedTaskReferences.current = [];
        let recoveryError: DeliveryRecoveryRequiredError | undefined;
        let authoritative: NormalizedDraft | undefined;
        try {
          deliveryStarted = true;
          authoritative = await store.deliver(mode, persisted, operationId);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === "task_reference_unresolved"
          ) {
            refreshTasksAfterUnresolvedReference();
          }
          if (error instanceof DeliveryRecoveryRequiredError) {
            recoveryError = error;
            authoritative = error.draft;
          } else {
            const transfer = store
              .getSnapshot()
              .pendingComposerTransfers.find(
                (candidate) => candidate.operationId === operationId,
              );
            if (
              transfer?.mode === "steer" &&
              transfer.steerPhase === "unconfirmed" &&
              !transfer.rollbackRequired
            ) {
              draftQueue.current!.setBlocked(true);
            } else if (
              transfer &&
              !transfer.rollbackApplied &&
              (transfer.rollbackRequired ||
                mode !== "steer" ||
                (error instanceof ApiError &&
                  error.status >= 400 &&
                  error.status < 500 &&
                  error.code !== "operation_outcome_uncertain" &&
                  error.code !== "backend_submission_unknown"))
            ) {
              rollbackHandled = restoreComposerContribution(
                operationId,
                transfer.captured,
                syncedDraft.current?.revision ?? transfer.captured.revision,
                "delivery_recovery_merge_limit",
              );
              if (rollbackHandled) {
                if (!transfer.retainTombstoneAfterRollback) {
                  rollbackRestorations.current.delete(operationId);
                }
                if (transfer.rollbackRequired) {
                  store.acknowledgeComposerTransferRollback(operationId);
                } else {
                  // Test doubles and synchronous preflight implementations may
                  // reject before they mark the transfer. Exact authoritative
                  // queue ownership removes it first, so only a still-present
                  // transfer is eligible for this cleanup.
                  store.abandonComposerTransfer(operationId);
                }
              }
            }
            throw error;
          }
        }
        if (!authoritative) return;
        if (
          !syncedDraft.current ||
          syncedDraft.current.revision <= authoritative.revision
        ) {
          syncedDraft.current = authoritative;
          lastSavedText.current = authoritative.text;
          lastSavedSkillId.current = authoritative.selectedSkillId;
          lastSavedContextExcerpts.current = authoritative.contextExcerpts;
          lastSavedAttachments.current = authoritative.attachments;
          lastSavedTaskReferences.current = authoritative.taskReferences;
        }
        if (recoveryError && mode === "steer") {
          // The provider boundary was crossed or is unknown. Keep the captured
          // contribution solely in the unconfirmed Steer row and keep all
          // post-clear autosaves behind this operation's barrier.
          draftQueue.current!.setBlocked(true);
          throw recoveryError;
        }
        const visibleAuthoritative =
          mode === "steer"
            ? visuallyClearedDraft(authoritative)
            : authoritative;
        rollbackHandled = restoreComposerContribution(
          operationId,
          visibleAuthoritative,
          authoritative.revision,
          recoveryError
            ? "delivery_recovery_merge_limit"
            : "delivered_merge_limit",
        );
        if (rollbackHandled) {
          const nextDirty = !draftValueMatchesDraft(
            currentDraftValue(),
            visibleAuthoritative,
          );
          dirtyRef.current = nextDirty;
          setDirty(nextDirty);
        }
        // Successful receipts are a merge with the cleared authoritative draft,
        // not a rollback contribution eligible for late inverse subtraction.
        if (!recoveryError) rollbackRestorations.current.delete(operationId);
        if (recoveryError && rollbackHandled) {
          const transfer = store
            .getSnapshot()
            .pendingComposerTransfers.find(
              (candidate) => candidate.operationId === operationId,
            );
          if (!transfer?.retainTombstoneAfterRollback) {
            rollbackRestorations.current.delete(operationId);
          }
          store.acknowledgeComposerTransferRollback(operationId);
        }
        if (recoveryError) throw recoveryError;
      });
    })()
      .catch(() => {
        if (!deliveryStarted) {
          store.abandonComposerTransfer(operationId);
          rollbackHandled = restoreComposerContribution(
            operationId,
            capturedDraft,
            syncedDraft.current?.revision ?? capturedDraft.revision,
            "delivery_recovery_merge_limit",
          );
          rollbackRestorations.current.delete(operationId);
        }
      })
      .finally(() => {
        draftMutationRunning.current = false;
        setDraftMutationPending(false);
        synchronizeRetainedComposerState();
      });
    return true;
  };
  excerptSendRef.current = (candidate) => send(candidate);

  const appendedCannedPromptValue = (
    prompt: ComposerPromptPickerItem,
  ): { readonly value: DraftValue; readonly caret: number } | undefined => {
    setPromptInputError(undefined);
    const target = textarea.current;
    const current = textRef.current;
    const start = target?.selectionStart ?? current.length;
    const end = target?.selectionEnd ?? start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const leading = before && !before.endsWith("\n") ? "\n\n" : "";
    const trailing = after && !after.startsWith("\n") ? "\n\n" : "";
    const insertion = `${leading}${prompt.prompt}${trailing}`;
    const next = `${before}${insertion}${after}`;
    const value: DraftValue = {
      text: next,
      ...(selectedSkillIdRef.current
        ? { selectedSkillId: selectedSkillIdRef.current }
        : {}),
      contextExcerpts: contextExcerptsRef.current,
      attachments: attachmentsRef.current,
      taskReferences: taskReferencesRef.current,
    };
    const parsed = normalizedDraftSchema.safeParse({
      ...value,
      revision: syncedDraft.current?.revision ?? 0,
    });
    if (!parsed.success) {
      setPromptInputError(
        parsed.error.issues[0]?.message ??
          "The saved prompt does not fit in the current draft.",
      );
      return undefined;
    }
    return { value, caret: before.length + insertion.length };
  };

  const appendCannedPrompt = (prompt: ComposerPromptPickerItem): void => {
    const appended = appendedCannedPromptValue(prompt);
    if (!appended) return;
    textRef.current = appended.value.text;
    dirtyRef.current = true;
    setText(appended.value.text);
    setDirty(true);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(appended.caret, appended.caret);
    });
  };

  const sendCannedPrompt = (prompt: ComposerPromptPickerItem): void => {
    const appended = appendedCannedPromptValue(prompt);
    if (!appended) return;
    send(appended.value);
  };

  const restoreStash = async (stashItem: NormalizedStash) => {
    if (draftMutationRunning.current || attachmentUploadPending) return;
    draftMutationRunning.current = true;
    setDraftMutationPending(true);
    const value = {
      text: textRef.current,
      selectedSkillId: selectedSkillIdRef.current,
      contextExcerpts: contextExcerptsRef.current,
      attachments: attachmentsRef.current,
      taskReferences: taskReferencesRef.current,
    };
    try {
      await draftQueue.current!.mutation(value, async (persisted) => {
        // The server appends restored text to a non-empty draft and retains
        // the current skill when one is already selected. Pre-mark that exact
        // echo so an SSE event beating the HTTP response remains recognizable
        // as this mutation's own write.
        lastSavedText.current = persisted.text.length
          ? `${persisted.text}\n\n${stashItem.text}`
          : stashItem.text;
        lastSavedSkillId.current =
          persisted.selectedSkillId ?? stashItem.selectedSkillId;
        lastSavedContextExcerpts.current = [
          ...persisted.contextExcerpts,
          ...stashItem.contextExcerpts,
        ];
        lastSavedAttachments.current = [
          ...persisted.attachments,
          ...stashItem.attachments,
        ];
        lastSavedTaskReferences.current = mergeUniqueTaskReferences(
          persisted.taskReferences,
          stashItem.taskReferences,
        );
        const result = await store.restoreStash(stashItem.id, persisted);
        if (
          !syncedDraft.current ||
          syncedDraft.current.revision <= result.revision
        ) {
          syncedDraft.current = result;
          lastSavedText.current = result.text;
          lastSavedSkillId.current = result.selectedSkillId;
          lastSavedContextExcerpts.current = result.contextExcerpts;
          lastSavedAttachments.current = result.attachments;
          lastSavedTaskReferences.current = result.taskReferences;
        }
        const textChanged = textRef.current !== persisted.text;
        const skillChanged =
          selectedSkillIdRef.current !== persisted.selectedSkillId;
        const mergedExcerpts = mergeAuthoritativeContextExcerpts(
          result.contextExcerpts,
          persisted.contextExcerpts,
          contextExcerptsRef.current,
        );
        const mergedAttachments = mergeAuthoritativeAttachments(
          result.attachments,
          persisted.attachments,
          attachmentsRef.current,
        );
        const mergedTaskReferences = mergeAuthoritativeTaskReferences(
          result.taskReferences,
          persisted.taskReferences,
          taskReferencesRef.current,
        );
        const mergedDraft = normalizedDraftSchema.safeParse({
          text: textChanged ? textRef.current : result.text,
          ...((
            skillChanged ? selectedSkillIdRef.current : result.selectedSkillId
          )
            ? {
                selectedSkillId: skillChanged
                  ? selectedSkillIdRef.current
                  : result.selectedSkillId,
              }
            : {}),
          contextExcerpts: mergedExcerpts,
          attachments: mergedAttachments,
          taskReferences: mergedTaskReferences,
          revision: result.revision,
        });
        if (!mergedDraft.success) {
          conflictRef.current = true;
          setDraftConflictCause("restore_merge_limit");
          setDraftConflict(true);
          return;
        }
        contextExcerptsRef.current = mergedDraft.data.contextExcerpts;
        setContextExcerpts(mergedDraft.data.contextExcerpts);
        attachmentsRef.current = mergedDraft.data.attachments;
        setAttachments(mergedDraft.data.attachments);
        taskReferencesRef.current = mergedDraft.data.taskReferences;
        setTaskReferences(mergedDraft.data.taskReferences);
        if (!textChanged) {
          setText(result.text);
        }
        if (!skillChanged) {
          setSelectedSkillId(result.selectedSkillId);
        }
        setDirty(
          textChanged ||
            skillChanged ||
            !contextExcerptArraysEqual(
              mergedDraft.data.contextExcerpts,
              result.contextExcerpts,
            ) ||
            !attachmentArraysEqual(
              mergedDraft.data.attachments,
              result.attachments,
            ) ||
            !taskReferenceArraysEqual(
              mergedDraft.data.taskReferences,
              result.taskReferences,
            ),
        );
      });
      setStashOpen(false);
    } finally {
      draftMutationRunning.current = false;
      setDraftMutationPending(false);
    }
  };

  const wholeComposerEmpty =
    text.length === 0 &&
    selectedSkillId === undefined &&
    contextExcerpts.length === 0 &&
    attachments.length === 0 &&
    taskReferences.length === 0 &&
    !attachmentUploadPending;
  const retainedAuthoritativeDraft =
    !dirty &&
    syncedDraft.current !== undefined &&
    (syncedDraft.current.text.length !== 0 ||
      syncedDraft.current.selectedSkillId !== undefined ||
      syncedDraft.current.contextExcerpts.length !== 0 ||
      syncedDraft.current.attachments.length !== 0 ||
      syncedDraft.current.taskReferences.length !== 0);
  const restoreQueuedInputUnavailableReason = effectiveDisabled
    ? "The message composer is unavailable."
    : draftConflict
      ? "Resolve the draft conflict before restoring a queued input."
      : state.pendingDeliveryThreadRevision !== undefined ||
          hasUnconfirmedSteerTransfer
        ? "Wait for the current delivery to settle before restoring a queued input."
        : draftMutationPending
          ? "Wait for the current composer action to finish."
          : !wholeComposerEmpty
            ? "Clear the composer before restoring a queued input."
            : retainedAuthoritativeDraft
              ? "Wait for the retained delivery draft to settle before restoring a queued input."
              : "Restore is unavailable right now.";
  const canRestoreQueuedInput =
    wholeComposerEmpty &&
    !effectiveDisabled &&
    !draftConflict &&
    !draftMutationPending &&
    !hasUnconfirmedSteerTransfer &&
    state.pendingDeliveryThreadRevision === undefined &&
    !retainedAuthoritativeDraft;

  const restoreQueuedInput = async (queuedInputId: string): Promise<void> => {
    if (!canRestoreQueuedInput || draftMutationRunning.current) {
      throw new Error(restoreQueuedInputUnavailableReason);
    }
    draftMutationRunning.current = true;
    queueRestoreRunning.current = true;
    setDraftMutationPending(true);
    setQueueRestorePending(true);
    const emptyValue: DraftValue = {
      text: "",
      selectedSkillId: undefined,
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
    };
    try {
      await draftQueue.current!.mutation(emptyValue, async (persisted) => {
        const result = await store.restoreQueuedInput(queuedInputId, persisted);
        syncedDraft.current = result;
        lastSavedText.current = result.text;
        lastSavedSkillId.current = result.selectedSkillId;
        lastSavedContextExcerpts.current = result.contextExcerpts;
        lastSavedAttachments.current = result.attachments;
        lastSavedTaskReferences.current = result.taskReferences;
        textRef.current = result.text;
        selectedSkillIdRef.current = result.selectedSkillId;
        contextExcerptsRef.current = result.contextExcerpts;
        attachmentsRef.current = result.attachments;
        taskReferencesRef.current = result.taskReferences;
        setText(result.text);
        setSelectedSkillId(result.selectedSkillId);
        setContextExcerpts([...result.contextExcerpts]);
        setAttachments([...result.attachments]);
        setTaskReferences([...result.taskReferences]);
        setDirty(false);
      });
      focusAfterQueueRestore.current = true;
    } finally {
      queueRestoreRunning.current = false;
      setQueueRestorePending(false);
      draftMutationRunning.current = false;
      setDraftMutationPending(false);
    }
  };

  const chooseCommand = (command: ComposerCommandDescriptor) => {
    if (queueRestoreRunning.current) return;
    setText(`${command.invocation} `);
    setDirty(true);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const chooseSkill = (skill: ComposerSkillDescriptor) => {
    if (queueRestoreRunning.current) return;
    const triggerQuery = skillTriggerQuery(textRef.current);
    if (triggerQuery !== undefined) setText("");
    setSelectedSkillId(skill.id);
    setDirty(true);
    setSkillPickerOpen(false);
    setSkillQuery("");
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const changeContextExcerptNote = (id: string, note?: string): boolean => {
    if (queueRestoreRunning.current) return false;
    const next = contextExcerptsRef.current.map((excerpt) =>
      excerpt.id === id
        ? { ...excerpt, ...(note ? { note } : { note: undefined }) }
        : excerpt,
    );
    const parsed = normalizedDraftSchema.safeParse({
      text: textRef.current,
      ...(selectedSkillIdRef.current
        ? { selectedSkillId: selectedSkillIdRef.current }
        : {}),
      contextExcerpts: next,
      attachments: attachmentsRef.current,
      taskReferences: taskReferencesRef.current,
      revision: syncedDraft.current?.revision ?? 0,
    });
    if (!parsed.success) return false;
    contextExcerptsRef.current = parsed.data.contextExcerpts;
    setContextExcerpts(parsed.data.contextExcerpts);
    setDirty(true);
    return true;
  };

  const removeContextExcerpt = (id: string) => {
    if (queueRestoreRunning.current) return;
    const next = contextExcerptsRef.current.filter(
      (excerpt) => excerpt.id !== id,
    );
    contextExcerptsRef.current = next;
    setContextExcerpts(next);
    setDirty(true);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const removeAttachment = (id: string) => {
    if (queueRestoreRunning.current) return;
    attachmentUploads.remove(id);
    const next = attachmentsRef.current.filter(
      (attachment) => attachment.id !== id,
    );
    attachmentsRef.current = next;
    setAttachments(next);
    setDirty(true);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const addAttachmentFiles = (
    files: readonly File[],
    preservePickerAdmission = false,
  ) => {
    if (queueRestoreRunning.current) return;
    setAttachmentInputError(undefined);
    const pickerMayResumeAfterNativeSuspension =
      preservePickerAdmission && !disabled && snapshot !== undefined;
    if (
      (effectiveDisabled && !pickerMayResumeAfterNativeSuspension) ||
      draftConflict
    ) {
      setAttachmentInputError(
        draftConflict
          ? "Resolve the draft conflict before attaching files."
          : "The message composer is unavailable.",
      );
      return;
    }
    const capability = snapshot?.capabilities.composerAttachments;
    if (capability?.fileStaging.availability !== "available") {
      setAttachmentInputError(
        capability?.fileStaging.availability === "unavailable"
          ? capability.fileStaging.reason.text
          : "Attachments are unavailable.",
      );
      return;
    }
    const existingCount =
      attachmentsRef.current.length + attachmentUploads.uploads.length;
    const existingBytes =
      attachmentsRef.current.reduce((sum, item) => sum + item.byteSize, 0) +
      attachmentUploads.uploads.reduce((sum, item) => sum + item.file.size, 0);
    const existingImages =
      attachmentsRef.current.filter(({ kind }) => kind === "image").length +
      attachmentUploads.uploads.filter((item) =>
        capability.policy.imageMediaTypes.includes(
          item.file.type as (typeof capability.policy.imageMediaTypes)[number],
        ),
      ).length;
    const accepted: File[] = [];
    let acceptedImages = 0;
    let aggregateBytes = existingBytes;
    for (const file of files) {
      if (!file.name || /[\0\r\n]/u.test(file.name)) {
        setAttachmentInputError("An attachment has an invalid file name.");
        continue;
      }
      if (
        existingCount + accepted.length >=
        capability.policy.maximumAttachments
      ) {
        setAttachmentInputError(
          `A prompt can contain at most ${capability.policy.maximumAttachments} attachments.`,
        );
        break;
      }
      const isRaster = capability.policy.imageMediaTypes.includes(
        file.type as (typeof capability.policy.imageMediaTypes)[number],
      );
      if (
        isRaster &&
        existingImages + acceptedImages >= capability.policy.maximumImages
      ) {
        setAttachmentInputError(
          `A prompt can contain at most ${capability.policy.maximumImages} images.`,
        );
        continue;
      }
      const maximumBytes = isRaster
        ? capability.policy.maximumImageBytes
        : capability.policy.maximumFileBytes;
      if (file.size > maximumBytes) {
        setAttachmentInputError(
          `${file.name} exceeds the ${Math.floor(maximumBytes / (1_024 * 1_024))} MiB limit.`,
        );
        continue;
      }
      if (
        new TextEncoder().encode(file.name).byteLength >
        COMPOSER_ATTACHMENT_LIMITS.maximumFileNameBytes
      ) {
        setAttachmentInputError(
          `${file.name} has a file name that is too long.`,
        );
        continue;
      }
      if (
        aggregateBytes + file.size >
        capability.policy.maximumAggregateBytes
      ) {
        setAttachmentInputError(
          "The attachments exceed the aggregate size limit.",
        );
        break;
      }
      aggregateBytes += file.size;
      if (isRaster) acceptedImages += 1;
      accepted.push(file);
    }
    if (accepted.length > 0) attachmentUploads.add(accepted);
  };

  const renderPromptPicker = (triggerVariant: "tab" | "toolbar") => {
    if (!showPromptsTab || !promptStore || tuiActive) return null;
    return (
      <ComposerPromptPicker
        active={active}
        triggerVariant={triggerVariant}
        catalog={(promptState?.library.items ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          prompt: item.text,
        }))}
        loading={!promptState || promptState.status === "loading"}
        error={promptState?.error}
        sendDisabled={promptSendDisabled}
        disabled={
          effectiveDisabled ||
          draftConflict ||
          draftMutationPending ||
          queueRestorePending ||
          attachmentUploadPending
        }
        currentDraftState={
          hasStashableDraft || attachmentUploadPending ? "dirty" : "empty"
        }
        onRetry={() => promptStore.refresh()}
        updateAvailable={promptState?.updateAvailable === true}
        onOpen={() => {
          promptStore.applyAvailableUpdate();
          return promptStore.revalidate();
        }}
        onApplyUpdate={() => promptStore.applyAvailableUpdate()}
        onAppend={appendCannedPrompt}
        onSend={sendCannedPrompt}
        onManage={() =>
          window.dispatchEvent(new CustomEvent(OPEN_PROMPTS_SETTINGS_EVENT))
        }
      />
    );
  };
  const promptsAboveComposer = promptsPlacement === "above_composer";
  const promptsInToolbar = promptsPlacement === "toolbar";

  return (
    <div className={`composer-wrap${tuiActive ? " tui-dock" : ""}`}>
      {showKeyBar && (
        <TerminalBottomControls
          inputAvailable={tuiInputAvailable}
          sendInput={(data) => terminalControl?.sendKey(data) ?? false}
          focusTerminal={() => terminalControl?.focusTerminal()}
          blurTerminal={() => terminalControl?.blurTerminal()}
          isTerminalFocused={() =>
            terminalControl?.isTerminalFocused() ?? false
          }
          afterBlurFocus={() => textarea.current?.focus()}
          trailingActions={
            <button
              type="button"
              className="terminal-key terminal-key-icon"
              aria-label="Stage draft in terminal"
              title="Stage draft in terminal"
              disabled={!canStageToTui}
              onClick={() => writeDraftToTerminal("stage")}
            >
              <TextCursorInput size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          }
        />
      )}
      {draftConflict && (
        <div className="composer-conflict" role="alert">
          {draftConflictCause === "delivered_merge_limit" ? (
            <span>
              Your message was sent, but edits made while it was sending exceed
              the draft limits. Your local draft is still here. Shorten it or
              remove attached context, then choose Keep mine. Use latest
              discards the local edits.
            </span>
          ) : draftConflictCause === "delivery_recovery_merge_limit" ? (
            <span>
              Delivery could not be confirmed, and edits made while it was in
              flight exceed the draft limits. Your local draft is still here.
              Shorten it or remove attached context, then choose Keep mine. Use
              latest adopts the server recovery draft and discards the local
              edits.
            </span>
          ) : draftConflictCause === "delivery_rollback_skill_conflict" ? (
            <span>
              The restored delivery and your newer draft select different
              skills. Your newer selection is still here. Choose Use latest to
              adopt the server draft, or Keep mine after resolving the skill
              choice.
            </span>
          ) : draftConflictCause === "restore_merge_limit" ? (
            <span>
              The restored prompt and your newer edits exceed the draft limits.
              Your local draft is still here. Shorten it or remove attached
              context, then choose Keep mine. Use latest discards the local
              edits.
            </span>
          ) : (
            <span>
              This draft changed in another client. Your local draft is still
              here.
            </span>
          )}
          <button onClick={useLatestDraft}>Use latest</button>
          <button onClick={() => void keepMineDraft().catch(() => undefined)}>
            Keep mine
          </button>
        </div>
      )}
      <div
        className="composer-stack"
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".composer-prompt-trigger")
          ) {
            setStashOpen(false);
            setSkillPickerOpen(false);
            setDismissedCommandDraft(textRef.current);
          }
        }}
      >
        {!tuiActive &&
          !promptsInToolbar &&
          (state.questionRequests.length > 0 ||
            (promptsAboveComposer && showPromptsTab && promptStore)) && (
            <div className="composer-prompt-rail">
              {!promptsInToolbar && <QuestionInboxButton />}
              {promptsAboveComposer && renderPromptPicker("tab")}
            </div>
          )}
        <QuestionInboxPanel />
        <Popover.Root open={active && stashOpen} onOpenChange={setStashOpen}>
          <Popover.Anchor asChild>
            <div className="composer-surface-stack">
              {!tuiActive && !hidePendingInputs && (
                <PendingInputStrip
                  store={store}
                  disabled={effectiveDisabled}
                  composerInput={textarea}
                  restoreAvailable={canRestoreQueuedInput}
                  restoreUnavailableReason={restoreQueuedInputUnavailableReason}
                  onRestore={restoreQueuedInput}
                  optimisticTranscriptPresentationVisible={
                    optimisticTranscriptPresentationVisible && chatViewVisible
                  }
                />
              )}
              {/* The stash popover is anchored to the complete surface stack,
                  not to its button or the height-changing composer card. This
                  keeps one stable gap above every pending-input configuration. */}
              <div
                className={`composer ${draftEditingDisabled ? "disabled" : ""}${
                  attachmentDragActive ? " attachment-drag-active" : ""
                }${taskDragActive ? " task-drag-active" : ""}`}
                data-testid="composer"
                data-task-drop-surface="composer"
                onDragEnter={(event) => {
                  if (taskDrag?.isTaskDrag(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    setTaskDragActive(true);
                    return;
                  }
                  if (
                    !Array.from(event.dataTransfer.items).some(
                      ({ kind }) => kind === "file",
                    )
                  )
                    return;
                  event.preventDefault();
                  setAttachmentDragActive(true);
                }}
                onDragOver={(event) => {
                  if (taskDrag?.isTaskDrag(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "copy";
                    return;
                  }
                  if (
                    !Array.from(event.dataTransfer.items).some(
                      ({ kind }) => kind === "file",
                    )
                  )
                    return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                  if (taskDrag?.isTaskDrag(event.dataTransfer)) {
                    event.stopPropagation();
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      setTaskDragActive(false);
                    }
                    return;
                  }
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    setAttachmentDragActive(false);
                  }
                }}
                onDrop={(event) => {
                  if (taskDrag?.isTaskDrag(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    setTaskDragActive(false);
                    const task = taskDrag.resolveDraggedTask(
                      event.dataTransfer,
                    );
                    taskDrag.endTaskDrag();
                    if (!task) {
                      taskDrag.announce(
                        "That task changed before it could be attached. Review it and try again.",
                        true,
                      );
                      return;
                    }
                    const result = stageTaskReference({
                      taskId: task.id,
                      titleSnapshot: task.title,
                    });
                    taskDrag.announce(
                      result.ok
                        ? `Added “${task.title}” to the prompt.`
                        : result.reason,
                      !result.ok,
                    );
                    return;
                  }
                  setAttachmentDragActive(false);
                  const files = Array.from(event.dataTransfer.files);
                  if (files.length === 0) return;
                  event.preventDefault();
                  addAttachmentFiles(files);
                }}
              >
                <div
                  className={`input-activity-bar${showLiveActivityBar && !tuiActive ? " visible" : ""}`}
                  aria-hidden="true"
                />
                <label className="sr-only" htmlFor={composerId}>
                  {tuiActive
                    ? "Send to TUI"
                    : `Message ${snapshot.capabilities.backend.label.text}`}
                </label>
                {selectedSkillId && (
                  <div
                    className="composer-skill-chip"
                    data-testid="selected-skill"
                  >
                    <Sparkles size={13} strokeWidth={1.9} aria-hidden="true" />
                    <span>
                      {selectedSkill?.displayName?.text ??
                        selectedSkill?.name.text ??
                        "Skill selected"}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove selected skill"
                      onClick={() => {
                        if (queueRestoreRunning.current) return;
                        setSelectedSkillId(undefined);
                        setDirty(true);
                        requestAnimationFrame(() => textarea.current?.focus());
                      }}
                    >
                      <X size={12} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {taskReferences.length > 0 && (
                  <div
                    className="composer-task-list"
                    aria-label="Attached tasks"
                  >
                    {taskReferences.map((reference) => {
                      const current = currentTasks.get(reference.taskId);
                      const state = taskProjectionChecking
                        ? "checking"
                        : current
                          ? current.completedAt
                            ? "completed"
                            : "available"
                          : "missing";
                      const label = current?.title ?? reference.titleSnapshot;
                      return (
                        <div
                          className="composer-task-chip"
                          data-state={state}
                          data-task-id={reference.taskId}
                          key={reference.taskId}
                        >
                          {state === "completed" ? (
                            <CircleCheck size={14} aria-hidden="true" />
                          ) : state === "missing" ? (
                            <AlertTriangle size={14} aria-hidden="true" />
                          ) : state === "checking" ? (
                            <LoaderCircle size={14} aria-hidden="true" />
                          ) : (
                            <ListTodo size={14} aria-hidden="true" />
                          )}
                          <span className="composer-task-title">{label}</span>
                          <span className="composer-task-state">
                            {state === "completed"
                              ? "Completed"
                              : state === "missing"
                                ? "Missing task"
                                : state === "checking"
                                  ? "Checking"
                                  : "Task"}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove task: ${label}`}
                            onClick={() =>
                              unstageTaskReference(reference.taskId)
                            }
                          >
                            <X size={12} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {missingTaskReferences.length > 0 && (
                  <div className="composer-task-error" role="alert">
                    Remove the missing task before sending.
                  </div>
                )}
                <ContextExcerptList
                  excerpts={contextExcerpts}
                  editable
                  onNoteChange={changeContextExcerptNote}
                  onRemove={removeContextExcerpt}
                />
                {(attachments.length > 0 ||
                  attachmentUploads.uploads.length > 0) && (
                  <AttachmentGroup
                    className="composer-attachment-list"
                    aria-label="Attachments"
                  >
                    {attachments.map((attachment) => (
                      <DurableAttachmentCard
                        key={attachment.id}
                        attachment={attachment}
                        loadContent={loadAttachmentContent}
                        localFile={attachmentUploads.localFiles.get(
                          attachment.id,
                        )}
                        onRemove={() => removeAttachment(attachment.id)}
                      />
                    ))}
                    {attachmentUploads.uploads.map((upload) => (
                      <LocalAttachmentCard
                        key={upload.id}
                        upload={upload}
                        onRemove={() => {
                          attachmentUploads.remove(upload.id);
                          // The upload may have resolved between this card's last
                          // paint and the click. Remove that just-linked immutable
                          // reference as well so X remains authoritative.
                          if (
                            attachmentsRef.current.some(
                              ({ id }) => id === upload.id,
                            )
                          ) {
                            removeAttachment(upload.id);
                          }
                        }}
                        onRetry={() => attachmentUploads.retry(upload.id)}
                      />
                    ))}
                  </AttachmentGroup>
                )}
                {attachmentInputError && (
                  <div className="composer-attachment-error" role="alert">
                    {attachmentInputError}
                  </div>
                )}
                {promptInputError && (
                  <div className="composer-attachment-error" role="alert">
                    {promptInputError}
                  </div>
                )}
                {tuiActive && tuiComposerNoticeReason && (
                  <div className="composer-terminal-notice" role="status">
                    {tuiComposerNoticeReason}
                  </div>
                )}
                {tuiActive && tuiSubmissionError && (
                  <div className="composer-terminal-error" role="alert">
                    {tuiSubmissionError}
                  </div>
                )}
                <textarea
                  ref={textarea}
                  autoFocus={active && autoFocus}
                  data-workspace-primary-focus="preferred"
                  data-sidebar-navigation-when-empty={
                    wholeComposerEmpty ? "true" : undefined
                  }
                  id={composerId}
                  rows={1}
                  value={text}
                  disabled={draftEditingDisabled || queueRestorePending}
                  aria-autocomplete="list"
                  aria-controls={
                    commandMenuOpen ? "composer-command-menu" : undefined
                  }
                  aria-expanded={commandMenuOpen}
                  aria-activedescendant={
                    commandMenuOpen && activeCommand
                      ? commandOptionId(
                          activeCommand,
                          effectiveActiveCommandIndex,
                        )
                      : undefined
                  }
                  placeholder={
                    tuiActive
                      ? "Send to TUI…"
                      : `Message ${snapshot.capabilities.backend.label.text}…`
                  }
                  onChange={(event) => {
                    if (queueRestoreRunning.current) return;
                    const input = event.nativeEvent;
                    if (
                      performance.now() < compositionGuardUntil.current &&
                      input instanceof InputEvent &&
                      (input.isComposing ||
                        input.inputType === "insertCompositionText" ||
                        input.inputType === "insertFromComposition" ||
                        input.inputType === "deleteCompositionText")
                    ) {
                      traceComposerInput("composition_update_discarded");
                      // Composition input is not always cancelable. Restore the
                      // accepted draft synchronously without changing focus.
                      event.currentTarget.value = textRef.current;
                      return;
                    }
                    traceComposerInput("change_accepted");
                    textRef.current = event.target.value;
                    setText(event.target.value);
                    setDirty(true);
                    if (tuiActive) setTuiSubmissionError(undefined);
                  }}
                  onFocus={() => {
                    if (tuiActive && terminalControl?.isTerminalFocused()) {
                      terminalControl.blurTerminal();
                    }
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files);
                    if (files.length > 0) addAttachmentFiles(files);
                  }}
                  onKeyDown={(event) => {
                    if (
                      commandMenuOpen &&
                      (event.key === "ArrowDown" || event.key === "ArrowUp")
                    ) {
                      event.preventDefault();
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      setActiveCommandIndex(
                        (index) =>
                          (index + direction + commandMatches.length) %
                          commandMatches.length,
                      );
                    } else if (
                      commandMenuOpen &&
                      activeCommand &&
                      (event.key === "Enter" || event.key === "Tab")
                    ) {
                      event.preventDefault();
                      chooseCommand(activeCommand);
                    } else if (commandMenuOpen && event.key === "Escape") {
                      event.preventDefault();
                      setDismissedCommandDraft(text);
                    } else if (
                      event.key === "Escape" &&
                      !event.nativeEvent.isComposing &&
                      document.querySelector(OPEN_OVERLAY_SELECTOR) === null
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.blur();
                    } else if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key.toLowerCase() === "s"
                    ) {
                      event.preventDefault();
                      void stash().catch(() => undefined);
                    } else if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      window.matchMedia("(pointer: fine)").matches
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                {commandMenuOpen && (
                  <div
                    id="composer-command-menu"
                    className="command-menu"
                    role="listbox"
                    aria-label="Commands"
                  >
                    {commandMatches.map((command, index) => (
                      <button
                        id={commandOptionId(command, index)}
                        key={`${command.source}:${command.invocation}`}
                        className={
                          index === effectiveActiveCommandIndex ? "active" : ""
                        }
                        role="option"
                        aria-selected={index === effectiveActiveCommandIndex}
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseCommand(command)}
                      >
                        <span>
                          <strong>{command.invocation}</strong>
                          {command.argumentHint && (
                            <em>{command.argumentHint.text}</em>
                          )}
                        </span>
                        {command.description && (
                          <small>{command.description.text}</small>
                        )}
                        <b>{command.source}</b>
                      </button>
                    ))}
                  </div>
                )}
                <div className="composer-footer">
                  <div className="composer-tools">
                    <Popover.Root
                      open={active && skillPickerOpen}
                      onOpenChange={(open) => {
                        setSkillPickerOpen(open);
                        if (!open) setSkillQuery("");
                      }}
                    >
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          onPointerDown={skillPickerFocus.onPointerDown}
                          onKeyDown={skillPickerFocus.onKeyDown}
                          className={`skill-button${selectedSkillId ? " active" : ""}`}
                          aria-label="Choose skill"
                          title="Choose skill (/skill)"
                          disabled={effectiveDisabled}
                        >
                          <Sparkles
                            size={15}
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal container={dialogContainer}>
                        <Popover.Content
                          collisionBoundary={dialogContainer ?? undefined}
                          onOpenAutoFocus={skillPickerFocus.onOpenAutoFocus}
                          className="skill-popover"
                          role="dialog"
                          aria-label="Choose a skill"
                          side="top"
                          align="start"
                          sideOffset={8}
                        >
                          <div className="skill-search">
                            <Search
                              size={14}
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                            <input
                              type="search"
                              value={skillQuery}
                              ref={skillSearchRef}
                              aria-label="Search skills"
                              placeholder="Search skills"
                              onChange={(event) =>
                                setSkillQuery(event.target.value)
                              }
                            />
                          </div>
                          <div className="skill-list">
                            {matchingSkills.map((skill) => (
                              <button
                                type="button"
                                key={skill.id}
                                aria-pressed={skill.id === selectedSkillId}
                                onClick={() => chooseSkill(skill)}
                              >
                                <span>
                                  <strong>
                                    {skill.displayName?.text ?? skill.name.text}
                                  </strong>
                                </span>
                                {skill.description && (
                                  <small>{skill.description.text}</small>
                                )}
                              </button>
                            ))}
                            {skillsLoading && skills.length === 0 && (
                              <p className="skill-status">Loading skills…</p>
                            )}
                            {!skillsLoading && skillsError && (
                              <div className="skill-status" role="alert">
                                <span>{skillsError}</span>
                                <button
                                  type="button"
                                  onClick={() => void loadSkills()}
                                >
                                  Retry
                                </button>
                              </div>
                            )}
                            {!skillsLoading &&
                              !skillsError &&
                              skills.length === 0 && (
                                <p className="skill-status">
                                  No skills available
                                </p>
                              )}
                            {!skillsLoading &&
                              !skillsError &&
                              skills.length > 0 &&
                              matchingSkills.length === 0 && (
                                <p className="skill-status">
                                  No matching skills
                                </p>
                              )}
                          </div>
                          <Popover.Arrow className="popover-arrow" />
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                    <input
                      ref={fileInput}
                      className="sr-only"
                      type="file"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(event) => {
                        const preservePickerAdmission =
                          attachmentPickerAdmitted.current;
                        attachmentPickerAdmitted.current = false;
                        addAttachmentFiles(
                          Array.from(event.currentTarget.files ?? []),
                          preservePickerAdmission,
                        );
                        event.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="attachment-button"
                      aria-label="Attach files"
                      title={
                        snapshot.capabilities.composerAttachments.fileStaging
                          .availability === "unavailable"
                          ? snapshot.capabilities.composerAttachments
                              .fileStaging.reason.text
                          : "Attach files"
                      }
                      disabled={
                        effectiveDisabled ||
                        draftConflict ||
                        snapshot.capabilities.composerAttachments.fileStaging
                          .availability !== "available"
                      }
                      onClick={() => {
                        attachmentPickerAdmitted.current = true;
                        fileInput.current?.click();
                      }}
                    >
                      <Paperclip
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </button>
                    <ThreadSettingsControls
                      store={store}
                      snapshot={snapshot}
                      disabled={effectiveDisabled}
                      variant="pill"
                    />
                  </div>
                  <div className="send-group">
                    <ProviderFeatureComposerActions
                      store={store}
                      snapshot={snapshot}
                      disabled={effectiveDisabled}
                      mobile={mobileComposerLayout}
                    />
                    <ContextUsageMeter usage={snapshot.usage.context} />
                    {promptsInToolbar && !tuiActive && (
                      <QuestionInboxButton variant="toolbar" />
                    )}
                    {promptsInToolbar &&
                      !tuiActive &&
                      renderPromptPicker("toolbar")}
                    <Popover.Trigger asChild>
                      <button
                        className={`stash-button ${state.stashes.length ? "has-stashes" : ""}`}
                        disabled={
                          effectiveDisabled ||
                          draftMutationPending ||
                          attachmentUploadPending
                        }
                        aria-label={
                          state.stashes.length
                            ? `Open ${state.stashes.length} stashed prompts`
                            : "Stash prompt"
                        }
                        title="Stash prompt (Ctrl/⌘+S)"
                        onClick={(event) => {
                          if (hasStashableDraft) {
                            event.preventDefault();
                            void stash().catch(() => undefined);
                          }
                        }}
                      >
                        <ArchiveRestore size={15} strokeWidth={1.8} />
                        {state.stashes.length > 0 && (
                          <span className="stash-count" aria-hidden="true">
                            {state.stashes.length}
                          </span>
                        )}
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="stash-popover"
                        role="dialog"
                        aria-label="Stashed prompts"
                        side="top"
                        align="end"
                        sideOffset={8}
                        onKeyDown={(event) => {
                          const last = state.stashes.length - 1;
                          if (last < 0) return;
                          if (
                            event.key === "ArrowDown" ||
                            event.key === "ArrowUp"
                          ) {
                            event.preventDefault();
                            const direction =
                              event.key === "ArrowDown" ? 1 : -1;
                            const next =
                              (activeStashIndex +
                                direction +
                                state.stashes.length) %
                              state.stashes.length;
                            setActiveStashIndex(next);
                            stashButtons.current[next]?.focus();
                          } else if (
                            event.key === "Home" ||
                            event.key === "End"
                          ) {
                            event.preventDefault();
                            const next = event.key === "Home" ? 0 : last;
                            setActiveStashIndex(next);
                            stashButtons.current[next]?.focus();
                          }
                        }}
                        onOpenAutoFocus={(event) => {
                          event.preventDefault();
                          requestAnimationFrame(() =>
                            stashButtons.current[0]?.focus(),
                          );
                        }}
                      >
                        <div className="stash-heading">
                          <div>
                            <strong>Stashed prompts</strong>
                            <small>Saved only for this thread</small>
                          </div>
                          {hasStashableDraft && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={
                                draftMutationPending || attachmentUploadPending
                              }
                              onClick={() =>
                                void stash().catch(() => undefined)
                              }
                            >
                              Stash current
                            </Button>
                          )}
                        </div>
                        <div
                          className="stash-list"
                          role="menu"
                          aria-label="Stashed prompts"
                        >
                          {state.stashes.map((stashItem, index) => (
                            <div className="stash-item" key={stashItem.id}>
                              <button
                                ref={(element) => {
                                  stashButtons.current[index] = element;
                                }}
                                className="stash-restore"
                                role="menuitem"
                                tabIndex={index === activeStashIndex ? 0 : -1}
                                disabled={
                                  draftMutationPending ||
                                  attachmentUploadPending
                                }
                                onFocus={() => setActiveStashIndex(index)}
                                onClick={() =>
                                  void restoreStash(stashItem).catch(
                                    () => undefined,
                                  )
                                }
                              >
                                <span>{stashPreviewLabel(stashItem)}</span>
                                <small>
                                  {relativeTime(stashItem.createdAt)}
                                  {stashItem.contextExcerpts.length
                                    ? ` · ${stashItem.contextExcerpts.length} context`
                                    : ""}
                                  {stashItem.attachments.length
                                    ? ` · ${stashItem.attachments.length} ${stashItem.attachments.length === 1 ? "attachment" : "attachments"}`
                                    : ""}
                                  {stashItem.taskReferences.length
                                    ? ` · ${stashItem.taskReferences.length} ${stashItem.taskReferences.length === 1 ? "task" : "tasks"}`
                                    : ""}
                                  {" · Restore"}
                                </small>
                              </button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="delete-stash"
                                aria-label="Delete stashed prompt"
                                onClick={() =>
                                  void store
                                    .deleteStash(stashItem.id)
                                    .catch(() => undefined)
                                }
                              >
                                <Trash2 size={15} strokeWidth={1.8} />
                              </Button>
                            </div>
                          ))}
                          {state.stashes.length === 0 && (
                            <div className="stash-empty">
                              <ArchiveRestore size={18} strokeWidth={1.8} />
                              <p>No stashed prompts</p>
                              <small>
                                Write an idea and press Ctrl/⌘+S to put it
                                aside.
                              </small>
                            </div>
                          )}
                        </div>
                        <Popover.Arrow className="popover-arrow" />
                      </Popover.Content>
                    </Popover.Portal>
                    {tuiActive ? (
                      <button
                        className="send-button"
                        aria-label="Send draft to TUI"
                        title={
                          tuiSubmitUnavailableReason ?? "Send draft to TUI"
                        }
                        disabled={!canSubmitToTui}
                        onPointerDown={() =>
                          traceComposerInput("send_pointerdown")
                        }
                        onClick={() => {
                          traceComposerInput("send_click");
                          send();
                        }}
                      >
                        <ArrowUp size={15} strokeWidth={1.8} />
                      </button>
                    ) : busy ? (
                      <>
                        {snapshot.runState !== "stopping" && (
                          <div className="delivery-split">
                            <button
                              className="queue-button delivery-split-submit"
                              aria-label={
                                deliveryMode === "steer" ? "Steer" : "Queue"
                              }
                              title={
                                deliveryMode === "steer" ? "Steer" : "Queue"
                              }
                              disabled={!canDeliver(deliveryMode)}
                              onPointerDown={() =>
                                traceComposerInput("send_pointerdown")
                              }
                              onClick={() => {
                                traceComposerInput("send_click");
                                send();
                              }}
                            >
                              {deliveryMode === "steer" ? (
                                <Merge size={16} aria-hidden="true" />
                              ) : (
                                <Layers size={16} aria-hidden="true" />
                              )}
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  className="delivery-split-menu"
                                  aria-label="Delivery mode"
                                  title="Delivery mode"
                                  disabled={
                                    effectiveDisabled ||
                                    state.actionPending ||
                                    draftMutationPending
                                  }
                                >
                                  <ChevronDown size={12} aria-hidden="true" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="top" align="end">
                                {supportedBusyDeliveryModes.map((mode) => {
                                  const id = mode.id as "steer" | "queue";
                                  return (
                                    <DropdownMenuItem
                                      key={id}
                                      disabled={!mode.available}
                                      onSelect={() => {
                                        setPreferredDeliveryMode(id);
                                        try {
                                          localStorage.setItem(
                                            "sedes-composer-delivery-mode",
                                            id,
                                          );
                                        } catch {
                                          /* Keep the session choice when storage is unavailable. */
                                        }
                                      }}
                                    >
                                      {id === "steer" ? (
                                        <Merge aria-hidden="true" />
                                      ) : (
                                        <Layers aria-hidden="true" />
                                      )}
                                      {id === "steer" ? "Steer" : "Queue"}
                                      {deliveryMode === id && (
                                        <Check
                                          className="ml-auto"
                                          aria-hidden="true"
                                        />
                                      )}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                        <button
                          className="send-button stop"
                          aria-label="Stop"
                          disabled={
                            effectiveDisabled ||
                            state.actionPending ||
                            snapshot.runState === "stopping" ||
                            !snapshot.capabilities.operations.some(
                              ({ id, available }) =>
                                id === "interrupt" && available,
                            )
                          }
                          onClick={() =>
                            void store.stopActiveTurn().catch(() => undefined)
                          }
                        >
                          <Square size={9} strokeWidth={2.6} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="send-button"
                          aria-label="Send message"
                          disabled={effectiveDisabled || !canDeliver("submit")}
                          onPointerDown={() =>
                            traceComposerInput("send_pointerdown")
                          }
                          onClick={() => {
                            traceComposerInput("send_click");
                            send();
                          }}
                        >
                          <ArrowUp size={15} strokeWidth={1.8} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Popover.Anchor>
        </Popover.Root>
      </div>
    </div>
  );
}

function matchingCommands(
  draft: string,
  commands: readonly ComposerCommandDescriptor[],
): ComposerCommandDescriptor[] {
  if (skillTriggerQuery(draft) !== undefined) return [];
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const query = draft.toLocaleLowerCase();
  return commands
    .filter(({ invocation }) =>
      invocation.toLocaleLowerCase().startsWith(query),
    )
    .slice(0, 12);
}

function skillTriggerQuery(draft: string): string | undefined {
  const match = /^\/skill(?:\s+([^\n]*))?$/i.exec(draft);
  return match ? (match[1] ?? "") : undefined;
}

/**
 * Removes only excerpt snapshots that are byte-for-byte identical to the
 * submitted/stashed snapshot. New excerpts and notes edited in flight remain
 * part of the next draft.
 */
function contextExcerptRemainder(
  current: readonly ContextExcerpt[],
  consumed: readonly ContextExcerpt[],
): ContextExcerpt[] {
  const consumedById = new Map(
    consumed.map((excerpt) => [excerpt.id, excerpt]),
  );
  return current.filter((excerpt) => {
    const prior = consumedById.get(excerpt.id);
    return !prior || !contextExcerptArraysEqual([excerpt], [prior]);
  });
}

function attachmentArraysEqual(
  left: readonly ComposerAttachmentDescriptor[],
  right: readonly ComposerAttachmentDescriptor[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

function taskReferenceArraysEqual(
  left: readonly ComposerTaskReference[],
  right: readonly ComposerTaskReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (reference, index) =>
        reference.taskId === right[index]?.taskId &&
        reference.titleSnapshot === right[index]?.titleSnapshot,
    )
  );
}

function taskReferenceIdArraysEqual(
  left: readonly ComposerTaskReference[],
  right: readonly ComposerTaskReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => reference.taskId === right[index]?.taskId)
  );
}

function taskReferenceRemainder(
  current: readonly ComposerTaskReference[],
  consumed: readonly ComposerTaskReference[],
): ComposerTaskReference[] {
  const consumedIds = new Set(consumed.map(({ taskId }) => taskId));
  return current.filter(({ taskId }) => !consumedIds.has(taskId));
}

function mergeUniqueTaskReferences(
  first: readonly ComposerTaskReference[],
  second: readonly ComposerTaskReference[],
): ComposerTaskReference[] {
  const seen = new Set<string>();
  return [...first, ...second].filter(({ taskId }) => {
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    return true;
  });
}

type ComposerMergeResult =
  | {
      readonly ok: true;
      readonly draft: NormalizedDraft;
      readonly skillConflict: boolean;
    }
  | { readonly ok: false; readonly cause: "limit" };

/**
 * Places an authoritative or rollback contribution before input created after
 * the atomic composer clear. Stable-ID collections keep the newer entry when
 * both sides contain the same identity; text preserves every byte and uses one
 * exact blank-line boundary only when both contributions are nonempty.
 */
function mergeComposerContribution(
  contribution: DraftValue,
  next: DraftValue,
  revision: number,
): ComposerMergeResult {
  const skillConflict = Boolean(
    contribution.selectedSkillId &&
    next.selectedSkillId &&
    contribution.selectedSkillId !== next.selectedSkillId,
  );
  const nextExcerptIds = new Set(next.contextExcerpts.map(({ id }) => id));
  const nextAttachmentIds = new Set(next.attachments.map(({ id }) => id));
  const nextTaskIds = new Set(next.taskReferences.map(({ taskId }) => taskId));
  const parsed = normalizedDraftSchema.safeParse({
    text:
      contribution.text && next.text
        ? `${contribution.text}\n\n${next.text}`
        : contribution.text || next.text,
    ...((next.selectedSkillId ?? contribution.selectedSkillId)
      ? {
          selectedSkillId: next.selectedSkillId ?? contribution.selectedSkillId,
        }
      : {}),
    contextExcerpts: [
      ...contribution.contextExcerpts.filter(
        ({ id }) => !nextExcerptIds.has(id),
      ),
      ...next.contextExcerpts,
    ],
    attachments: [
      ...contribution.attachments.filter(
        ({ id }) => !nextAttachmentIds.has(id),
      ),
      ...next.attachments,
    ],
    taskReferences: [
      ...contribution.taskReferences.filter(
        ({ taskId }) => !nextTaskIds.has(taskId),
      ),
      ...next.taskReferences,
    ],
    revision,
  });
  return parsed.success
    ? { ok: true, draft: parsed.data, skillConflict }
    : { ok: false, cause: "limit" };
}

function draftValueMatchesDraft(
  value: DraftValue,
  draft: NormalizedDraft,
): boolean {
  return (
    value.text === draft.text &&
    value.selectedSkillId === draft.selectedSkillId &&
    contextExcerptArraysEqual(value.contextExcerpts, draft.contextExcerpts) &&
    attachmentArraysEqual(value.attachments, draft.attachments) &&
    taskReferenceArraysEqual(value.taskReferences, draft.taskReferences)
  );
}

function draftValueFromDraft(draft: NormalizedDraft): DraftValue {
  return {
    text: draft.text,
    selectedSkillId: draft.selectedSkillId,
    contextExcerpts: draft.contextExcerpts,
    attachments: draft.attachments,
    taskReferences: draft.taskReferences,
  };
}

function normalizedDraftFromValue(
  value: DraftValue,
  revision: number,
): NormalizedDraft {
  return {
    text: value.text,
    ...(value.selectedSkillId
      ? { selectedSkillId: value.selectedSkillId }
      : {}),
    contextExcerpts: [...value.contextExcerpts],
    attachments: [...value.attachments],
    taskReferences: [...value.taskReferences],
    revision,
  };
}

function subtractRestoredContextExcerpts(
  current: readonly ContextExcerpt[],
  before: readonly ContextExcerpt[],
  after: readonly ContextExcerpt[],
  onAmbiguous: () => void,
): ContextExcerpt[] {
  const beforeIds = new Set(before.map(({ id }) => id));
  const restored = new Map(
    after.filter(({ id }) => !beforeIds.has(id)).map((item) => [item.id, item]),
  );
  return current.filter((item) => {
    const prior = restored.get(item.id);
    if (!prior) return true;
    if (contextExcerptArraysEqual([item], [prior])) return false;
    onAmbiguous();
    return true;
  });
}

function subtractRestoredAttachments(
  current: readonly ComposerAttachmentDescriptor[],
  before: readonly ComposerAttachmentDescriptor[],
  after: readonly ComposerAttachmentDescriptor[],
  onAmbiguous: () => void,
): ComposerAttachmentDescriptor[] {
  const beforeIds = new Set(before.map(({ id }) => id));
  const restored = new Map(
    after.filter(({ id }) => !beforeIds.has(id)).map((item) => [item.id, item]),
  );
  return current.filter((item) => {
    const prior = restored.get(item.id);
    if (!prior) return true;
    if (composerAttachmentDescriptorsEqual(item, prior)) return false;
    onAmbiguous();
    return true;
  });
}

function subtractRestoredTaskReferences(
  current: readonly ComposerTaskReference[],
  before: readonly ComposerTaskReference[],
  after: readonly ComposerTaskReference[],
  onAmbiguous: () => void,
): ComposerTaskReference[] {
  const beforeIds = new Set(before.map(({ taskId }) => taskId));
  const restored = new Map(
    after
      .filter(({ taskId }) => !beforeIds.has(taskId))
      .map((item) => [item.taskId, item]),
  );
  return current.filter((item) => {
    const prior = restored.get(item.taskId);
    if (!prior) return true;
    if (taskReferenceArraysEqual([item], [prior])) return false;
    onAmbiguous();
    return true;
  });
}

function composerAttachmentDescriptorsEqual(
  left: ComposerAttachmentDescriptor,
  right: ComposerAttachmentDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.fileName === right.fileName &&
    left.kind === right.kind &&
    left.mediaType === right.mediaType &&
    left.byteSize === right.byteSize
  );
}

function mergeAuthoritativeTaskReferences(
  authoritative: readonly ComposerTaskReference[],
  persisted: readonly ComposerTaskReference[],
  current: readonly ComposerTaskReference[],
): ComposerTaskReference[] {
  const persistedById = new Map(persisted.map((item) => [item.taskId, item]));
  const currentById = new Map(current.map((item) => [item.taskId, item]));
  const authoritativeIds = new Set(authoritative.map(({ taskId }) => taskId));
  const merged = authoritative.flatMap((item) => {
    const prior = persistedById.get(item.taskId);
    if (!prior) return [currentById.get(item.taskId) ?? item];
    const local = currentById.get(item.taskId);
    if (!local) return [];
    return [taskReferenceArraysEqual([local], [prior]) ? item : local];
  });
  for (const item of current) {
    if (!authoritativeIds.has(item.taskId) && !persistedById.has(item.taskId)) {
      merged.push(item);
    }
  }
  return merged;
}

function stashPreviewLabel(stash: NormalizedStash): string {
  const text = stash.text.replace(/\s+/g, " ").trim();
  if (text) return text;
  if (stash.contextExcerpts.length) {
    return `${stash.contextExcerpts.length} context ${stash.contextExcerpts.length === 1 ? "excerpt" : "excerpts"}`;
  }
  if (stash.attachments.length) {
    return `${stash.attachments.length} ${stash.attachments.length === 1 ? "attachment" : "attachments"}`;
  }
  if (stash.taskReferences.length) {
    return (
      stash.taskReferences[0]?.titleSnapshot.trim() ||
      `${stash.taskReferences.length} ${stash.taskReferences.length === 1 ? "task" : "tasks"}`
    );
  }
  return stash.selectedSkillId ? "Skill prompt" : "Empty prompt";
}

function attachmentRemainder(
  current: readonly ComposerAttachmentDescriptor[],
  consumed: readonly ComposerAttachmentDescriptor[],
): ComposerAttachmentDescriptor[] {
  const consumedIds = new Set(consumed.map(({ id }) => id));
  return current.filter(({ id }) => !consumedIds.has(id));
}

function mergeAuthoritativeAttachments(
  authoritative: readonly ComposerAttachmentDescriptor[],
  persisted: readonly ComposerAttachmentDescriptor[],
  current: readonly ComposerAttachmentDescriptor[],
): ComposerAttachmentDescriptor[] {
  const persistedIds = new Set(persisted.map(({ id }) => id));
  const currentById = new Map(current.map((item) => [item.id, item]));
  const merged = authoritative.flatMap((item) => {
    if (!persistedIds.has(item.id)) return [currentById.get(item.id) ?? item];
    return currentById.has(item.id) ? [item] : [];
  });
  const authoritativeIds = new Set(authoritative.map(({ id }) => id));
  for (const item of current) {
    if (!authoritativeIds.has(item.id) && !persistedIds.has(item.id)) {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Applies context edits made while a draft mutation was in flight to its
 * authoritative receipt. Server-retained or restored excerpts remain, while
 * local additions, removals, and note edits relative to the submitted draft
 * are carried into the next draft.
 */
function mergeAuthoritativeContextExcerpts(
  authoritative: readonly ContextExcerpt[],
  persisted: readonly ContextExcerpt[],
  current: readonly ContextExcerpt[],
): ContextExcerpt[] {
  const persistedById = new Map(
    persisted.map((excerpt) => [excerpt.id, excerpt]),
  );
  const currentById = new Map(current.map((excerpt) => [excerpt.id, excerpt]));
  const authoritativeIds = new Set(authoritative.map(({ id }) => id));
  const merged = authoritative.flatMap((excerpt) => {
    const prior = persistedById.get(excerpt.id);
    if (!prior) {
      return [currentById.get(excerpt.id) ?? excerpt];
    }
    const local = currentById.get(excerpt.id);
    if (!local) return [];
    return [contextExcerptArraysEqual([local], [prior]) ? excerpt : local];
  });
  for (const excerpt of current) {
    if (authoritativeIds.has(excerpt.id)) continue;
    const prior = persistedById.get(excerpt.id);
    if (!prior || !contextExcerptArraysEqual([excerpt], [prior])) {
      merged.push(excerpt);
    }
  }
  return merged;
}

function visuallyClearedDraft(draft: NormalizedDraft): NormalizedDraft {
  return {
    text: "",
    contextExcerpts: [],
    attachments: [],
    taskReferences: [],
    revision: draft.revision,
    ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
  };
}

function commandOptionId(
  command: ComposerCommandDescriptor,
  index: number,
): string {
  return `composer-command-${index}-${command.invocation
    .replace(/[^a-z0-9_-]+/gi, "-")
    .toLocaleLowerCase()}`;
}
