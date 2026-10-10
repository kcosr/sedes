import { forwardRef, useImperativeHandle, useState } from "react";
import type { TerminalResource } from "../../shared/index.js";

/**
 * A stand-in for the terminal renderer in PanelLayout tests: it records an
 * instance number per mount and can simulate a remote removal.
 */
let instanceSequence = 0;

export function resetTerminalPanelFixture(): void {
  instanceSequence = 0;
}

export const TerminalPanelFixture = forwardRef(function TerminalPanelFixture(
  props: {
    readonly terminal: TerminalResource;
    readonly visible?: boolean;
    readonly lifecycleError?: string;
    readonly onRemoved?: (terminalId: string) => void;
  },
  ref: React.ForwardedRef<unknown>,
) {
  const [instanceId] = useState(() => ++instanceSequence);
  useImperativeHandle(ref, () => ({
    openSearch: () => undefined,
    openTranscript: () => undefined,
    clearSelection: () => undefined,
    claimControl: () => undefined,
    releaseControl: () => undefined,
    retryConnection: () => undefined,
    retryNotSentInput: () => undefined,
    discardUnconfirmedInput: () => undefined,
    focus: () => true,
  }));
  return (
    <section
      aria-label={`${props.terminal.displayName} terminal`}
      data-terminal-panel-instance={instanceId}
      data-visible={props.visible ? "true" : "false"}
    >
      {props.lifecycleError ? <p role="alert">{props.lifecycleError}</p> : null}
      <span>stale rendered terminal history</span>
      <button
        type="button"
        onClick={() => props.onRemoved?.(props.terminal.terminalId)}
      >
        Simulate terminal removed
      </button>
    </section>
  );
});
