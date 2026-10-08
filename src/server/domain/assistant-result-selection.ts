import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type {
  NotificationAssistantResultPhase,
  SelectedAssistantResult,
} from "../../shared/protocol/notification.js";
import type { BoundedText } from "../../shared/protocol/payload.js";

/** Serialized JSON limit of a notification payload; turn reply speech shares it. */
export const NOTIFICATION_PAYLOAD_BYTES = 65_536;

export const fitsNotificationBudget = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= NOTIFICATION_PAYLOAD_BYTES;

/** Keep the longest code-point prefix that fits, marking byte-limit truncation; false if even empty text cannot. */
export function fitBoundedText(
  original: BoundedText,
  fits: () => boolean,
  assign: (text: BoundedText) => void,
): boolean {
  const points = Array.from(original.text);
  const candidate = (count: number): BoundedText => {
    const text = points.slice(0, count).join("") + (count > 0 ? "…" : "");
    return { text, truncation: {
      ...original.truncation,
      truncated: true,
      retainedBytes: Buffer.byteLength(text, "utf8"),
      reason: "byte_limit",
    } };
  };
  let best = candidate(0);
  assign(best);
  if (!fits()) return false;
  let low = 1;
  let high = Math.max(0, points.length - 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const next = candidate(middle);
    assign(next);
    if (fits()) { best = next; low = middle + 1; }
    else high = middle - 1;
  }
  assign(best);
  return true;
}

/**
 * Select the principal's `assistantResultPhases` from a stored classification
 * and fit them, as `assistantResult` beside `envelope`'s other fields, into the
 * notification budget. Unselected sections are never read or cloned; omitted
 * keys mean excluded, and a selected `null` stays null. Unclassified, then
 * provisional, then final text shortens first. Returns undefined only when even
 * empty sections cannot fit beside the envelope.
 */
export function selectAssistantResult(
  result: ClassifiedAssistantResult,
  phases: readonly NotificationAssistantResultPhase[],
  envelope: object = {},
): SelectedAssistantResult | undefined {
  const sections: SelectedAssistantResult = {};
  // Select before reading or cloning: omitted response phases need no work.
  for (const phase of ["provisional", "final", "unclassified"] as const) {
    if (phases.includes(phase)) {
      sections[phase] = structuredClone(result[phase]);
    }
  }
  const measured = { ...envelope, assistantResult: sections };
  const fits = () => fitsNotificationBudget(measured);
  if (fits()) return sections;
  for (const phase of ["unclassified", "provisional", "final"] as const) {
    const original = sections[phase];
    if (original == null || original.text.length === 0) continue;
    if (fitBoundedText(original, fits, (text) => { sections[phase] = text; })) return sections;
  }
  return fits() ? sections : undefined;
}
