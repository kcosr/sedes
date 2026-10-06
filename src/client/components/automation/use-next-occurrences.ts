import { useEffect, useState } from "react";
import type { AutomationSchedule } from "../../../shared/protocol/automation.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AUTOMATION_PREVIEW_COUNT } from "./use-automation-editor.js";

/**
 * The next few occurrences of a schedule, from the server's preview, kept
 * current: they are asked for again when the schedule or the summary's next
 * run changes, and when the earliest one passes on the caller's clock (the
 * minute clock), since scheduled runs move the next run on without changing
 * the schedule. Occurrences that have passed are never returned.
 */
export function useNextOccurrences(
  store: Pick<ApplicationClientStore, "api">,
  threadId: string,
  schedule: AutomationSchedule | undefined,
  nextRunAt: string | undefined,
  now: Date,
): readonly string[] {
  const [preview, setPreview] = useState<{
    readonly key: string;
    readonly occurrences: readonly string[];
  }>({ key: "", occurrences: [] });
  const [passings, setPassings] = useState(0);
  const key = schedule ? `${JSON.stringify(schedule)} ${nextRunAt ?? ""}` : "";
  const current = preview.key === key ? preview.occurrences : [];
  const first = current[0];
  // True from the moment the earliest occurrence passes until a fresh
  // preview replaces it; each change to true asks once, so a server whose
  // clock lags cannot make it ask in a loop.
  const passed = first !== undefined && Date.parse(first) <= now.getTime();
  useEffect(() => {
    if (passed) setPassings((count) => count + 1);
  }, [passed]);
  useEffect(() => {
    if (!schedule) return;
    const controller = new AbortController();
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
            setPreview({ key, occurrences: result.occurrences });
          }
        },
        // The schedule's sentence still says when; the preview is a nicety.
        () => undefined,
      );
    return () => controller.abort();
    // The key stands for the schedule's content and the next run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, passings, store, threadId]);
  return current.filter((occurrence) => Date.parse(occurrence) > now.getTime());
}
