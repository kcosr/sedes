import { useId, useRef, useState, type ReactNode } from "react";
import type {
  OperationPhase,
  SafeItemError,
} from "../../../shared/index.js";
import { ChevronDown } from "lucide-react";

export function OperationShell({
  title,
  target,
  summary,
  phase,
  error,
  children,
}: {
  title: string;
  target?: ReactNode;
  summary?: ReactNode;
  phase: OperationPhase;
  error?: SafeItemError;
  children?: ReactNode;
}): React.JSX.Element {
  // Operations always mount collapsed — live-rendered cards match the
  // collapsed presentation a history reload produces, and the header still
  // carries the phase dot and status while work is in flight.
  const [open, setOpen] = useState(false);
  const [targetScrolled, setTargetScrolled] = useState(false);
  const detailsId = useId();
  const targetRef = useRef<HTMLSpanElement>(null);
  const pointerStart = useRef<{ x: number; y: number; scrollLeft: number } | null>(null);
  const dragged = useRef(false);
  const tone = phaseTone(phase);
  return (
    <section
      className="op-card"
      data-operation-phase={phase}
      data-operation-tone={tone}
    >
      <button
        aria-controls={detailsId}
        aria-expanded={open}
        className="op-head"
        onClick={(event) => {
          if (event.detail !== 0 && dragged.current) {
            dragged.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
        onPointerDown={() => { dragged.current = false; }}
        onKeyDown={(event) => {
          const targetElement = targetRef.current;
          if (!targetElement ||
              targetElement.scrollWidth <= targetElement.clientWidth ||
              (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          targetElement.scrollLeft += event.key === "ArrowRight" ? 120 : -120;
        }}
        type="button"
      >
        <span aria-hidden="true" className={`op-dot ${tone}`} />
        <span className="op-verb">{title}</span>
        {target !== undefined && target !== null && target !== "" && (
          <span
            className="op-target op-target-scroll"
            data-scrolled={targetScrolled}
            ref={targetRef}
            onScroll={(event) => {
              setTargetScrolled(event.currentTarget.scrollLeft > 0);
            }}
            onPointerDown={(event) => {
              pointerStart.current = {
                x: event.clientX, y: event.clientY,
                scrollLeft: event.currentTarget.scrollLeft,
              };
            }}
            onPointerMove={(event) => {
              const start = pointerStart.current;
              if (!start || event.buttons !== 1) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
              dragged.current = true;
              if (event.pointerType === "mouse" && Math.abs(dx) > Math.abs(dy)) {
                event.currentTarget.setPointerCapture(event.pointerId);
                event.currentTarget.scrollLeft = start.scrollLeft - dx;
                event.preventDefault();
              }
            }}
            onPointerUp={() => { pointerStart.current = null; }}
            onPointerCancel={() => { pointerStart.current = null; }}
          >{target}</span>
        )}
        {summary !== undefined && summary !== null && (
          <span className="op-summary">{summary}</span>
        )}
        <span className="sr-only">{phaseLabel(phase)}. </span>
        {error?.message.text && (
          <span className="sr-only">{error.message.text}</span>
        )}
        <ChevronDown
          className={`op-chevron${open ? " rotate" : ""}`}
          size={14}
          strokeWidth={1.8}
        />
      </button>
      {open && (
        <div className="op-body operation-details" id={detailsId}>
          {error?.message.text && (
            <p className="op-error">{error.message.text}</p>
          )}
          {children ?? <pre>No details available.</pre>}
        </div>
      )}
    </section>
  );
}

export function phaseLabel(phase: OperationPhase): string {
  switch (phase) {
    case "arguments_streaming":
      return "Preparing arguments…";
    case "arguments_complete":
      return "Arguments ready";
    case "preflight_or_executing":
      return "Running…";
    case "result_streaming":
      return "Receiving output…";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
  }
}

function phaseTone(
  phase: OperationPhase,
): "running" | "success" | "error" {
  if (phase === "completed") return "success";
  if (phase === "failed" || phase === "interrupted") return "error";
  return "running";
}
