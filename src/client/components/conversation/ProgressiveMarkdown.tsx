import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  isSmoothStreamingEffective,
  useSmoothStreaming,
} from "../../app/use-smooth-streaming.js";
import { recordStreamingDiagnostic } from "../../app/diagnostics.js";
import { MarkdownContent } from "./MarkdownContent";
import {
  beginTerminalSettlement,
  createOpaqueStreamFade,
  hasPendingFade,
  observeStreamFade,
  TERMINAL_SETTLE_MS,
  type StreamFadeState,
} from "./smooth-streaming-text.js";
import {
  MarkdownStreamFadeContext,
  rehypeStreamFade,
} from "./markdown-stream-fade.js";

type AnimatedPresentation = {
  readonly fade: StreamFadeState;
  readonly phase: "streaming" | "settling";
  readonly renderedAtMs: number;
  readonly settleDeadlineMs?: number;
};

export function ProgressiveMarkdown({
  children,
  streaming,
  copyCodeBlocks = false,
  sourcePositionMetadata = false,
  animationActive = true,
  onPresentationActiveChange,
}: {
  children: string;
  streaming: boolean;
  /** Adds copy controls to fenced code blocks in the rendered Markdown. */
  readonly copyCodeBlocks?: boolean;
  readonly sourcePositionMetadata?: boolean;
  /** Hidden reasoning keeps its content mounted, but must not keep a RAF alive. */
  readonly animationActive?: boolean;
  /** Lets selection owners wait for the terminal fade cleanup. */
  readonly onPresentationActiveChange?: (active: boolean) => void;
}): React.JSX.Element {
  const [presentation, setPresentation] = useState<
    AnimatedPresentation | undefined
  >(() =>
    initialPresentation(
      children,
      streaming,
      animationActive && isSmoothStreamingEffective(),
    ),
  );
  const smoothStreaming = useSmoothStreaming(
    animationActive && (streaming || presentation !== undefined),
  );
  const smoothingEnabled = smoothStreaming && animationActive;
  const presentationActive = presentation !== undefined;
  const previousAnimationFrameAt = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (!streaming) return;
    recordStreamingDiagnostic("text_committed", {
      itemStatus: "streaming",
      textCharacters: children.length,
    });
  }, [children, streaming]);

  useLayoutEffect(() => {
    onPresentationActiveChange?.(presentationActive);
  }, [onPresentationActiveChange, presentationActive]);

  useLayoutEffect(() => {
    const nowMs = performance.now();

    setPresentation((previous) => {
      if (!smoothingEnabled) return undefined;

      if (streaming) {
        const fade = previous
          ? observeStreamFade(previous.fade, children, nowMs)
          : createOpaqueStreamFade(children, nowMs);
        if (
          previous?.phase === "streaming" &&
          previous.fade === fade
        ) {
          return previous;
        }
        return {
          fade,
          phase: "streaming",
          renderedAtMs: nowMs,
        };
      }

      if (!previous) return undefined;
      if (
        previous.phase === "settling" &&
        previous.fade.source === children
      ) {
        return previous;
      }

      // A terminal item update can carry the final appended delta. Observe it
      // before starting the bounded handoff so that last batch is not skipped.
      const observed = observeStreamFade(previous.fade, children, nowMs);
      return {
        fade: beginTerminalSettlement(observed, nowMs),
        phase: "settling",
        renderedAtMs: nowMs,
        settleDeadlineMs: nowMs + TERMINAL_SETTLE_MS,
      };
    });
  }, [children, smoothingEnabled, streaming]);

  useEffect(() => {
    if (!presentation) {
      previousAnimationFrameAt.current = undefined;
      return undefined;
    }
    if (!hasPendingFade(presentation.fade, presentation.renderedAtMs)) {
      previousAnimationFrameAt.current = undefined;
      return undefined;
    }
    const frame = requestAnimationFrame((nowMs) => {
      const priorFrameAt =
        previousAnimationFrameAt.current ?? presentation.renderedAtMs;
      const frameGapMilliseconds = nowMs - priorFrameAt;
      previousAnimationFrameAt.current = nowMs;
      if (frameGapMilliseconds >= 50) {
        recordStreamingDiagnostic("animation_frame_delayed", {
          animatedGraphemes: presentation.fade.animated.length,
          durationMilliseconds: frameGapMilliseconds,
        });
      }
      setPresentation((current) =>
        current ? { ...current, renderedAtMs: nowMs } : current,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [presentation]);

  useEffect(() => {
    if (
      presentation?.phase !== "settling" ||
      presentation.settleDeadlineMs === undefined
    ) {
      return undefined;
    }
    const delayMs = Math.max(
      0,
      presentation.settleDeadlineMs - performance.now(),
    );
    const timeout = window.setTimeout(() => setPresentation(undefined), delayMs);
    return () => window.clearTimeout(timeout);
  }, [presentation?.phase, presentation?.settleDeadlineMs]);

  // Only source observations change the parser plugin. Animation frames update
  // context consumers in the bounded text spans, not the Markdown parser.
  const fade = presentation?.fade;
  const rehypePlugins = useMemo(
    () => fade ? [rehypeStreamFade(fade)] : [],
    [fade],
  );
  const records = useMemo(
    () => new Map(fade?.animated.map((record) => [record.index, record])),
    [fade],
  );
  const frame = useMemo(() => presentation ? {
    records,
    nowMs: presentation.renderedAtMs,
  } : undefined, [presentation, records]);

  return (
    <div
      className="progressive-markdown"
      data-streaming={streaming ? "true" : "false"}
    >
      <div
        className={presentation ? "progressive-markdown-animated" : undefined}
        data-animated-graphemes={fade?.animated.length}
      >
        <MarkdownStreamFadeContext.Provider value={frame}>
          <MarkdownContent
            copyCodeBlocks={copyCodeBlocks}
            enableMermaid
            rehypePlugins={rehypePlugins}
            sourcePositionMetadata={sourcePositionMetadata && !presentation}
            streaming={streaming}
          >
            {fade?.source ?? children}
          </MarkdownContent>
        </MarkdownStreamFadeContext.Provider>
      </div>
    </div>
  );
}

function initialPresentation(
  source: string,
  streaming: boolean,
  smoothingEnabled: boolean,
): AnimatedPresentation | undefined {
  if (!streaming || !smoothingEnabled) return undefined;
  const nowMs = performance.now();
  return {
    fade: createOpaqueStreamFade(source, nowMs),
    phase: "streaming",
    renderedAtMs: nowMs,
  };
}
