import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { SendHorizontal, TextCursorInput } from "lucide-react";
import { TerminalBottomControls } from "./TerminalBottomControls.js";
import { isImeComposingKeyEvent } from "./terminal-ime-input.js";

export interface TerminalMobileControlsProps {
  readonly inputAvailable: boolean;
  readonly sendInput: (data: string) => boolean;
  readonly focusTerminal: () => void;
  readonly blurTerminal: () => void;
  readonly isTerminalFocused: () => boolean;
  readonly commandInputRef?: RefObject<HTMLTextAreaElement | null>;
}

/** Touch-first terminal input modeled after Herdr's compact native command dock. */
export function TerminalMobileControls({
  inputAvailable,
  sendInput,
  focusTerminal,
  blurTerminal,
  isTerminalFocused,
  commandInputRef,
}: TerminalMobileControlsProps): React.JSX.Element {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = commandInputRef ?? fallbackRef;
  const [draft, setDraft] = useState("");

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    const maximum = Math.max(34, Math.floor(window.innerHeight * 0.34));
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
  }, [draft, inputRef]);

  const clearAcceptedDraft = () => {
    setDraft("");
  };
  const submit = (mode: "stage" | "send") => {
    const payload = mode === "send" ? `${draft}\r` : draft;
    if (!payload || !sendInput(payload)) return;
    clearAcceptedDraft();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isImeComposingKeyEvent(event.nativeEvent)
    )
      return;
    event.preventDefault();
    submit("send");
  };

  return (
    <div className="terminal-mobile-controls">
      <TerminalBottomControls
        inputAvailable={inputAvailable}
        sendInput={sendInput}
        focusTerminal={focusTerminal}
        blurTerminal={blurTerminal}
        isTerminalFocused={isTerminalFocused}
      />
      <div className="terminal-mobile-command-row">
        <textarea
          ref={inputRef}
          className="terminal-mobile-command-input"
          aria-label="Terminal command"
          placeholder={inputAvailable ? "Type a command" : "Take control to type"}
          value={draft}
          rows={1}
          disabled={!inputAvailable}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="terminal-mobile-command-action"
          aria-label="Stage command in terminal"
          title="Stage without Enter"
          disabled={!inputAvailable || draft.length === 0}
          onClick={() => submit("stage")}
        >
          <TextCursorInput size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="terminal-mobile-command-action"
          aria-label="Send command to terminal"
          title="Send with Enter"
          disabled={!inputAvailable}
          onClick={() => submit("send")}
        >
          <SendHorizontal size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
