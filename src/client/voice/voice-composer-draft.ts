import {
  appendThreadReferenceText, formatInlineThreadReferenceText, formatThreadReferenceText, readThreadReferenceBody,
} from "../../shared/thread-references.js";

/** A recording is literal speech, even if its transcript resembles a saved mention. */
export function prependVoiceToDraft<T extends { readonly text: string }>(draft: T, speech: string): T {
  const spoken = formatInlineThreadReferenceText([speech]);
  const { legacyReferences, parts } = readThreadReferenceBody(draft.text);
  if (legacyReferences.length) {
    const combined = [speech, ...parts].filter(Boolean).join("\n\n");
    const literal = formatInlineThreadReferenceText([combined]);
    const text = literal === combined
      ? formatThreadReferenceText(combined, legacyReferences)
      : formatInlineThreadReferenceText([...legacyReferences.flatMap((ref) => [ref, " "]), combined]);
    return { ...draft, text };
  }
  return { ...draft, text: appendThreadReferenceText(spoken, draft.text) };
}
