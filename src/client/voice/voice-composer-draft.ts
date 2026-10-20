import { replaceThreadReferenceBody, splitThreadReferenceText } from "../../shared/thread-references.js";

/** Keep the encoded references and every non-text field of the original draft. */
export function prependVoiceToDraft<T extends { readonly text: string }>(draft: T, speech: string): T {
  const body = splitThreadReferenceText(draft.text).text;
  return {
    ...draft,
    text: replaceThreadReferenceBody(draft.text, body.length ? `${speech}\n\n${body}` : speech),
  };
}
