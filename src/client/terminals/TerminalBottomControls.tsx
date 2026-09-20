import { useEffect, useRef, useState, type ReactNode } from "react";
import { SquareTerminal } from "lucide-react";

export interface TerminalBottomControlsProps {
  readonly inputAvailable: boolean;
  readonly sendInput: (data: string) => boolean;
  readonly focusTerminal: () => void;
  readonly blurTerminal: () => void;
  readonly isTerminalFocused: () => boolean;
  readonly afterBlurFocus?: () => void;
  readonly trailingActions?: ReactNode;
}

export const TERMINAL_QUICK_KEYS: ReadonlyArray<{
  readonly label: string;
  readonly data: string;
  readonly ariaLabel?: string;
}> = Object.freeze([
  { label: "Esc", data: "\u001b" },
  { label: "Tab", data: "\t" },
  { label: "Ctrl+C", data: "\u0003", ariaLabel: "Send Ctrl+C to terminal" },
  { label: "←", data: "\u001b[D", ariaLabel: "Send left arrow to terminal" },
  { label: "↓", data: "\u001b[B", ariaLabel: "Send down arrow to terminal" },
  { label: "↑", data: "\u001b[A", ariaLabel: "Send up arrow to terminal" },
  { label: "→", data: "\u001b[C", ariaLabel: "Send right arrow to terminal" },
]);

/** Provider-neutral terminal keys and soft-keyboard focus toggle. */
export function TerminalBottomControls({
  inputAvailable,
  sendInput,
  focusTerminal,
  blurTerminal,
  isTerminalFocused,
  afterBlurFocus,
  trailingActions,
}: TerminalBottomControlsProps): React.JSX.Element {
  const [terminalFocused, setTerminalFocused] = useState(false);
  const terminalFocusedBeforePointerRef = useRef<boolean | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!inputAvailable) {
      setTerminalFocused(false);
      return;
    }
    const synchronizeFocus = () => setTerminalFocused(isTerminalFocused());
    document.addEventListener("focusin", synchronizeFocus);
    synchronizeFocus();
    return () => document.removeEventListener("focusin", synchronizeFocus);
  }, [inputAvailable, isTerminalFocused]);

  const toggleTerminalKeyboard = () => {
    const terminalFocusedBeforePointer = terminalFocusedBeforePointerRef.current;
    terminalFocusedBeforePointerRef.current = undefined;
    if (!inputAvailable) return;
    const wasTerminalFocused =
      terminalFocusedBeforePointer ?? isTerminalFocused();
    if (wasTerminalFocused) {
      blurTerminal();
      setTerminalFocused(false);
      afterBlurFocus?.();
      return;
    }
    focusTerminal();
    setTerminalFocused(true);
  };

  return (
    <div
      className="terminal-key-bar"
      data-testid="terminal-key-bar"
      role="group"
      aria-label="Terminal keys"
    >
      {TERMINAL_QUICK_KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          className="terminal-key"
          aria-label={key.ariaLabel ?? key.label}
          disabled={!inputAvailable}
          onClick={() => {
            setTerminalFocused(false);
            sendInput(key.data);
          }}
        >
          {key.label}
        </button>
      ))}
      <button
        type="button"
        className="terminal-key terminal-key-icon terminal-key-focus"
        aria-label="Focus terminal keyboard"
        title="Type in terminal"
        aria-pressed={terminalFocused}
        disabled={!inputAvailable}
        onPointerDown={() => {
          terminalFocusedBeforePointerRef.current = isTerminalFocused();
        }}
        onPointerCancel={() => {
          terminalFocusedBeforePointerRef.current = undefined;
        }}
        onTouchStart={() => {
          terminalFocusedBeforePointerRef.current = isTerminalFocused();
        }}
        onTouchCancel={() => {
          terminalFocusedBeforePointerRef.current = undefined;
        }}
        onClick={toggleTerminalKeyboard}
      >
        <SquareTerminal size={15} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {trailingActions}
    </div>
  );
}
