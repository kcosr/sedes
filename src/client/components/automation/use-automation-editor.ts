import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationSchedule } from "../../../shared/protocol/automation.js";
import { ApiError } from "../../api/ApiClient.js";
import { mutationId } from "../../lib/ids.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type {
  AutomationPrecheckTestResult,
  ThreadAutomationDefinition,
} from "../../types.js";
import {
  MAXIMUM_PRECHECK_COMMAND_BYTES,
  MAXIMUM_PROMPT_BYTES,
  defaultAutomationForm,
  formFromDefinition,
  precheckFromForm,
  sameAutomationForm,
  scheduleFromForm,
  utf8Bytes,
  validPrecheckTimeout,
  type AutomationForm,
} from "./automation-form.js";
import type { AutomationThread } from "./use-automation-thread.js";

/** Occurrences the editor and the page preview. */
export const AUTOMATION_PREVIEW_COUNT = 3;
const PREVIEW_DEBOUNCE_MS = 200;

type EditorStore = Pick<ApplicationClientStore, "api">;

export interface AutomationEditorValidation {
  readonly promptBytes: number;
  readonly promptError?: string;
  readonly commandBytes: number;
  readonly commandError?: string;
  readonly timeoutError?: string;
  /** The form asks for a fork per run, which the thread cannot do. */
  readonly cloneUnavailable: boolean;
  readonly valid: boolean;
}

export interface AutomationEditor {
  readonly mode: "create" | "edit";
  readonly definition?: ThreadAutomationDefinition;
  /** `loading` while the saved definition is read for the first time. */
  readonly status: "loading" | "ready" | "error";
  readonly loadError?: string;
  readonly form: AutomationForm;
  /** Changes the form; ignored while a save or delete is in flight. */
  readonly update: (patch: Partial<AutomationForm>) => void;
  readonly schedule?: AutomationSchedule;
  readonly preview: {
    readonly occurrences: readonly string[];
    readonly error?: string;
    /** The current schedule has not been previewed yet. */
    readonly checking: boolean;
  };
  readonly validation: AutomationEditorValidation;
  readonly dirty: boolean;
  /** The automation changed elsewhere while this form has edits; Reload discards them. */
  readonly stale: boolean;
  /** The last run's outcome is unknown; nothing may change until it is resolved. */
  readonly uncertain: boolean;
  /** The automation this form edited was deleted elsewhere; saving creates a new one. */
  readonly deletedElsewhere: boolean;
  /** A note about a reload the editor made on its own (a create conflict). */
  readonly notice?: string;
  readonly pending?: "save" | "save_and_enable" | "delete";
  readonly error?: string;
  /** Saves the form (and enables a new automation when asked); true when all of it succeeded. */
  readonly save: (options?: { readonly enable?: boolean }) => Promise<boolean>;
  /** Deletes the automation, then stays pending while the caller leaves; rejects with the server's message. */
  readonly remove: () => Promise<void>;
  /** Puts the form back to the saved (or new) values. */
  readonly reset: () => void;
  /** Reads the saved definition again, discarding edits. */
  readonly reload: () => void;
  readonly precheckTest: {
    readonly canTest: boolean;
    readonly testing: boolean;
    readonly result?: AutomationPrecheckTestResult;
    readonly run: () => void;
  };
}

/**
 * The automation editor's state for one thread: the form and its baseline
 * (the saved definition, or a new automation's defaults), validity, the
 * schedule preview, dirty tracking, saving, and the "changed elsewhere"
 * rule. The live thread summary decides the mode: an automation on it is
 * edited, otherwise one is created. A newer revision on the summary reloads
 * a clean form and marks an edited one stale until the user reloads it.
 */
export function useAutomationEditor(
  store: EditorStore,
  thread: Pick<AutomationThread, "id" | "automation">,
  options: { readonly canCloneOnRun: boolean },
): AutomationEditor {
  const threadId = thread.id;
  const live = thread.automation;
  const liveRevision = live?.revision;
  const [initial] = useState(() => defaultAutomationForm(new Date()));
  const [definition, setDefinition] = useState<ThreadAutomationDefinition>();
  const [form, setForm] = useState<AutomationForm>(initial);
  const [baseline, setBaseline] = useState<AutomationForm>(initial);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pending, setPending] = useState<AutomationEditor["pending"]>();
  // Read synchronously by update(): an edit made while a request runs would
  // be overwritten by the response.
  const pendingRef = useRef(pending);
  const markPending = useCallback((next: AutomationEditor["pending"]) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deletedElsewhere, setDeletedElsewhere] = useState(false);
  const [preview, setPreview] = useState<{
    readonly key: string;
    readonly occurrences: readonly string[];
    readonly error?: string;
  }>({ key: "", occurrences: [] });
  const [precheckTesting, setPrecheckTesting] = useState(false);
  const [precheckResult, setPrecheckResult] = useState<AutomationPrecheckTestResult>();
  const precheckController = useRef<AbortController | undefined>(undefined);
  const loadedRevision = useRef<number | undefined>(undefined);
  const handledAttempt = useRef(0);

  const dirty = !sameAutomationForm(form, baseline);
  const remoteAhead =
    liveRevision !== undefined &&
    (definition === undefined || liveRevision > definition.revision);

  const adopt = useCallback((loaded: ThreadAutomationDefinition) => {
    const next = formFromDefinition(loaded, new Date());
    setDefinition(loaded);
    setForm(next);
    setBaseline(next);
    setDeletedElsewhere(false);
    setPrecheckResult(undefined);
  }, []);

  // Read the saved definition when the summary is ahead of the form: on
  // open, and after a change elsewhere while the form is clean. An edited
  // form waits for an explicit reload (the stale alert).
  useEffect(() => {
    const explicit = loadAttempt > handledAttempt.current;
    handledAttempt.current = loadAttempt;
    if (liveRevision === undefined || pending) return;
    if (!explicit && (!remoteAhead || dirty || loadedRevision.current === liveRevision)) {
      return;
    }
    loadedRevision.current = liveRevision;
    const controller = new AbortController();
    let settled = false;
    setLoading(true);
    setLoadError(undefined);
    store.api.getThreadAutomation(threadId, controller.signal).then(
      (loaded) => {
        if (controller.signal.aborted) return;
        settled = true;
        adopt(loaded);
        setLoading(false);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        settled = true;
        setLoadError(messageFrom(reason));
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
      // An interrupted read is retried by the next run of this effect.
      if (!settled && loadedRevision.current === liveRevision) {
        loadedRevision.current = undefined;
      }
    };
  }, [adopt, dirty, liveRevision, loadAttempt, pending, remoteAhead, store, threadId]);

  // Deleted elsewhere (the summary loses the automation, and this editor
  // did not delete it): the form stays, and saving creates a new one.
  const previousLiveRevision = useRef(liveRevision);
  useEffect(() => {
    const previous = previousLiveRevision.current;
    previousLiveRevision.current = liveRevision;
    if (previous === undefined || liveRevision !== undefined || pending === "delete") {
      return;
    }
    setDefinition(undefined);
    setDeletedElsewhere(true);
  }, [liveRevision, pending]);

  // An automation that appears elsewhere while a new one is being written
  // leaves the form in create mode, stale, until the user reloads.
  const mode: AutomationEditor["mode"] =
    definition !== undefined || (live !== null && !dirty) ? "edit" : "create";
  const status: AutomationEditor["status"] =
    mode === "edit" && definition === undefined
      ? loadError !== undefined && !loading
        ? "error"
        : "loading"
      : "ready";

  const schedule = useMemo(
    () => scheduleFromForm(form, definition?.schedule),
    [definition?.schedule, form],
  );
  const scheduleKey = schedule ? JSON.stringify(schedule) : "";

  useEffect(() => {
    if (status !== "ready" || !schedule) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      store.api
        .previewThreadAutomationSchedule(
          threadId,
          schedule,
          AUTOMATION_PREVIEW_COUNT,
          controller.signal,
        )
        .then(
          (result) => {
            if (!controller.signal.aborted) {
              setPreview({ key: scheduleKey, occurrences: result.occurrences });
            }
          },
          (reason: unknown) => {
            if (!controller.signal.aborted) {
              setPreview({ key: scheduleKey, occurrences: [], error: messageFrom(reason) });
            }
          },
        );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [schedule, scheduleKey, status, store, threadId]);
  const previewCurrent = preview.key === scheduleKey && scheduleKey !== "";

  const prompt = form.prompt.trim();
  const promptBytes = utf8Bytes(prompt);
  const commandBytes = utf8Bytes(form.precheckCommand.trim());
  const precheck = precheckFromForm(form);
  const cloneUnavailable = form.runMode === "clone" && !options.canCloneOnRun;
  const validation: AutomationEditorValidation = {
    promptBytes,
    ...(promptBytes > MAXIMUM_PROMPT_BYTES
      ? { promptError: "The prompt must be at most 65,536 UTF-8 bytes." }
      : {}),
    commandBytes,
    ...(form.precheckEnabled && commandBytes > MAXIMUM_PRECHECK_COMMAND_BYTES
      ? { commandError: "The command must be at most 4,096 UTF-8 bytes." }
      : {}),
    ...(form.precheckEnabled && !validPrecheckTimeout(form.precheckTimeout)
      ? { timeoutError: "Enter a whole number of seconds from 1 to 60." }
      : {}),
    cloneUnavailable,
    valid:
      prompt.length > 0 &&
      promptBytes <= MAXIMUM_PROMPT_BYTES &&
      schedule !== undefined &&
      precheck.valid &&
      !cloneUnavailable &&
      previewCurrent &&
      preview.error === undefined,
  };

  // From the live summary alone: resolving the run elsewhere changes its
  // state without a new revision, so the definition read at load would keep
  // a resolved run uncertain.
  const uncertain = live?.lastRun?.state === "uncertain";
  const stale = remoteAhead && dirty;

  // A changed precheck input voids the last test.
  const precheckFingerprint = JSON.stringify([
    prompt,
    form.precheckEnabled,
    form.precheckCommand,
    form.precheckTimeout,
    form.precheckIncludeStdout,
  ]);
  const precheckFingerprintRef = useRef(precheckFingerprint);
  precheckFingerprintRef.current = precheckFingerprint;
  useEffect(() => {
    precheckController.current?.abort();
    precheckController.current = undefined;
    setPrecheckTesting(false);
    setPrecheckResult(undefined);
  }, [precheckFingerprint]);
  useEffect(() => () => precheckController.current?.abort(), []);

  const runPrecheckTest = useCallback(() => {
    if (!precheck.precheck || !prompt) return;
    precheckController.current?.abort();
    const controller = new AbortController();
    const tested = precheckFingerprint;
    precheckController.current = controller;
    setPrecheckTesting(true);
    setPrecheckResult(undefined);
    setError(undefined);
    store.api
      .testThreadAutomationPrecheck(threadId, prompt, precheck.precheck, controller.signal)
      .then(
        (result) => {
          if (
            !controller.signal.aborted &&
            precheckFingerprintRef.current === tested
          ) {
            setPrecheckResult(result);
          }
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setError(messageFrom(reason));
        },
      )
      .finally(() => {
        if (precheckController.current === controller) {
          precheckController.current = undefined;
          setPrecheckTesting(false);
        }
      });
  }, [precheck.precheck, precheckFingerprint, prompt, store, threadId]);

  const save = async (saveOptions?: { readonly enable?: boolean }): Promise<boolean> => {
    if (!schedule || !validation.valid || pending || stale || uncertain) return false;
    const enable = saveOptions?.enable === true && definition === undefined;
    markPending(enable ? "save_and_enable" : "save");
    setError(undefined);
    setNotice(undefined);
    const fields = {
      prompt,
      runMode: form.runMode,
      schedule,
      misfirePolicy: form.misfirePolicy,
      precheck: precheck.precheck,
    };
    let saved: ThreadAutomationDefinition;
    try {
      saved = definition
        ? await store.api.updateThreadAutomation(threadId, {
            ...fields,
            expectedRevision: definition.revision,
            mutationId: mutationId(),
          })
        : await store.api.createThreadAutomation(threadId, {
            ...fields,
            mutationId: mutationId(),
          });
    } catch (reason) {
      if (!definition && reason instanceof ApiError && reason.code === "conflict") {
        // Another client attached one first: show it instead of this form.
        try {
          adopt(await store.api.getThreadAutomation(threadId));
          setNotice(
            "This thread already has an automation, so its saved settings are shown instead.",
          );
        } catch (reloadReason) {
          setError(messageFrom(reloadReason));
        }
      } else {
        setError(messageFrom(reason));
      }
      markPending(undefined);
      return false;
    }
    adopt(saved);
    if (enable) {
      try {
        adopt(
          await store.api.setThreadAutomationState(
            threadId,
            "enable",
            saved.revision,
            mutationId(),
          ),
        );
      } catch (reason) {
        setError(`Saved as paused. It could not be enabled: ${messageFrom(reason)}`);
        markPending(undefined);
        return false;
      }
    }
    markPending(undefined);
    return true;
  };

  const remove = async (): Promise<void> => {
    if (!definition) return;
    markPending("delete");
    setError(undefined);
    try {
      await store.api.deleteThreadAutomation(threadId, definition.revision, mutationId());
    } catch (reason) {
      markPending(undefined);
      throw new Error(messageFrom(reason));
    }
    // The editor leaves after a delete; staying pending keeps it from
    // reading the summary's loss of the automation as a delete elsewhere.
  };

  return {
    mode,
    ...(definition ? { definition } : {}),
    status,
    ...(loadError === undefined ? {} : { loadError }),
    form,
    update: useCallback((patch: Partial<AutomationForm>) => {
      if (pendingRef.current !== undefined) return;
      setForm((current) => ({ ...current, ...patch }));
    }, []),
    ...(schedule ? { schedule } : {}),
    preview: {
      occurrences: previewCurrent ? preview.occurrences : [],
      ...(previewCurrent && preview.error !== undefined ? { error: preview.error } : {}),
      checking: schedule !== undefined && !previewCurrent,
    },
    validation,
    dirty,
    stale,
    uncertain,
    deletedElsewhere,
    ...(notice === undefined ? {} : { notice }),
    ...(pending === undefined ? {} : { pending }),
    ...(error === undefined ? {} : { error }),
    save,
    remove,
    reset: useCallback(() => {
      setForm(baseline);
      setError(undefined);
    }, [baseline]),
    reload: useCallback(() => setLoadAttempt((current) => current + 1), []),
    precheckTest: {
      canTest: precheck.precheck !== null && prompt.length > 0,
      testing: precheckTesting,
      ...(precheckResult ? { result: precheckResult } : {}),
      run: runPrecheckTest,
    },
  };
}
