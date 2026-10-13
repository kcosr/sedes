export const OPEN_THREAD_REFERENCE_PICKER_EVENT = "sedes-open-thread-reference-picker";

/** A presentation request for the active thread's composer, with no mutation. */
export function openThreadReferencePicker(threadId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_THREAD_REFERENCE_PICKER_EVENT, {
    detail: { threadId },
  }));
}
