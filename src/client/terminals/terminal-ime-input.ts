/** State reducer for the hidden textarea used by a browser terminal IME. */
export type TerminalImeState =
  | {
      readonly phase: "idle";
      readonly preedit: "";
      readonly pendingInput:
        | { readonly kind: "commit"; readonly text: string }
        | { readonly kind: "cancellation"; readonly remaining: string }
        | null;
    }
  | {
      readonly phase: "composing";
      readonly baseline: string;
      readonly preedit: string;
      readonly pendingInput: null;
    };

export type TerminalImeEvent =
  | { readonly type: "compositionstart"; readonly data: string; readonly textareaValue: string }
  | { readonly type: "compositionupdate"; readonly data: string; readonly textareaValue: string }
  | { readonly type: "compositionend"; readonly data: string; readonly textareaValue: string }
  | {
      readonly type: "input";
      readonly data: string | null;
      readonly inputType: string;
      readonly isComposing: boolean;
      readonly textareaValue: string;
    }
  | { readonly type: "settle" }
  | { readonly type: "reset" };

export interface TerminalImeTransition {
  readonly state: TerminalImeState;
  readonly output: string | null;
  readonly suppressInput: boolean;
  readonly clearTextarea: boolean;
}

export function idleTerminalImeState(): TerminalImeState {
  return { phase: "idle", preedit: "", pendingInput: null };
}

/**
 * Keeps preedit local and emits a completed composition exactly once despite
 * browsers disagreeing about whether the final input event precedes or follows
 * compositionend.
 */
export function reduceTerminalImeState(
  state: TerminalImeState,
  event: TerminalImeEvent,
): TerminalImeTransition {
  switch (event.type) {
    case "compositionstart":
      return transition({
        phase: "composing",
        baseline: event.textareaValue,
        preedit: event.data,
        pendingInput: null,
      });
    case "compositionupdate":
      return state.phase === "composing"
        ? transition({ ...state, preedit: event.data })
        : transition(state);
    case "compositionend": {
      if (state.phase !== "composing") {
        return transition(state, { suppressInput: true });
      }
      const output = normalizeTerminalText(event.data);
      const canceledPreedit = output === null
        ? normalizeTerminalText(state.preedit) ??
          normalizeTerminalText(textareaSuffix(state.baseline, event.textareaValue))
        : null;
      return transition(
        {
          phase: "idle",
          preedit: "",
          pendingInput: output
            ? { kind: "commit", text: output }
            : canceledPreedit
              ? { kind: "cancellation", remaining: canceledPreedit }
              : null,
        },
        { output, suppressInput: true, clearTextarea: true },
      );
    }
    case "input": {
      if (state.phase === "composing") {
        const preedit = typeof event.data === "string"
          ? event.data
          : textareaSuffix(state.baseline, event.textareaValue);
        return transition({ ...state, preedit }, { suppressInput: true });
      }
      if (event.isComposing || isImeCompositionInputType(event.inputType)) {
        return transition(
          { ...state, pendingInput: null },
          { suppressInput: true, clearTextarea: true },
        );
      }
      if (state.pendingInput !== null) {
        const candidate =
          normalizeTerminalText(event.data) ??
          normalizeTerminalText(event.textareaValue) ?? "";
        if (
          state.pendingInput.kind === "commit" &&
          candidate === state.pendingInput.text
        ) {
          return transition(
            { ...state, pendingInput: null },
            { suppressInput: true, clearTextarea: true },
          );
        }
        if (
          state.pendingInput.kind === "cancellation" &&
          event.inputType === "insertText" &&
          candidate !== "" &&
          state.pendingInput.remaining.startsWith(candidate)
        ) {
          const remaining = state.pendingInput.remaining.slice(candidate.length);
          return transition(
            {
              ...state,
              pendingInput: remaining
                ? { kind: "cancellation", remaining }
                : null,
            },
            { suppressInput: true, clearTextarea: true },
          );
        }
        return transition({ ...state, pendingInput: null });
      }
      return transition(state);
    }
    case "settle":
      return state.phase === "idle"
        ? transition({ ...state, pendingInput: null })
        : transition(state);
    case "reset":
      return transition(idleTerminalImeState(), {
        suppressInput: state.phase === "composing",
        clearTextarea: state.phase === "composing",
      });
  }
}

export function shouldDeferBeforeInputToIme(
  state: TerminalImeState,
  event: Pick<InputEvent, "data" | "inputType" | "isComposing">,
): boolean {
  if (
    state.phase === "composing" ||
    event.isComposing ||
    isImeCompositionInputType(event.inputType)
  ) return true;
  if (state.pendingInput === null) return false;
  const candidate = normalizeTerminalText(event.data);
  return state.pendingInput.kind === "commit"
    ? candidate === state.pendingInput.text
    : event.inputType === "insertText" &&
        candidate !== null &&
        state.pendingInput.remaining.startsWith(candidate);
}

export function isImeComposingKeyEvent(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function beforeInputOutput(
  event: Pick<InputEvent, "inputType" | "data">,
): string | null {
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
      return normalizeTerminalText(event.data);
    case "insertLineBreak":
    case "insertParagraph":
      return "\r";
    case "deleteContentBackward":
      return "\x7f";
    case "deleteContentForward":
      return "\x1b[3~";
    default:
      return null;
  }
}

export function keyboardEventOutput(
  event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "key">,
): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key.length === 1) return event.key;
  switch (event.key) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Delete": return "\x1b[3~";
    default: return null;
  }
}

export function textareaDelta(previousValue: string, nextValue: string): string {
  if (nextValue.startsWith(previousValue)) {
    return nextValue.slice(previousValue.length).replace(/\n/g, "\r");
  }
  const previous = Array.from(previousValue);
  const next = Array.from(nextValue);
  let common = 0;
  while (
    common < previous.length &&
    common < next.length &&
    previous[common] === next[common]
  ) common += 1;
  return `${"\x7f".repeat(previous.length - common)}${next
    .slice(common)
    .join("")
    .replace(/\n/g, "\r")}`;
}

function isImeCompositionInputType(inputType: string): boolean {
  return inputType === "insertCompositionText" ||
    inputType === "deleteCompositionText" ||
    inputType === "insertFromComposition" ||
    inputType === "deleteByComposition";
}

function textareaSuffix(baseline: string, value: string): string {
  return value.startsWith(baseline) ? value.slice(baseline.length) : value;
}

function normalizeTerminalText(value: string | null | undefined): string | null {
  return value ? value.replace(/\n/g, "\r") : null;
}

function transition(
  state: TerminalImeState,
  overrides: Partial<Omit<TerminalImeTransition, "state">> = {},
): TerminalImeTransition {
  return {
    state,
    output: null,
    suppressInput: false,
    clearTextarea: false,
    ...overrides,
  };
}
