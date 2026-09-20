import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import { MarkdownContent } from "../conversation/MarkdownContent.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

const DISPLAY_MILLISECONDS = 3_500;
const CROSSFADE_MILLISECONDS = 180;
const ANNOUNCEMENT_DEBOUNCE_MILLISECONDS = 650;
const COMPACT_SUMMARY_MAX_CHARACTERS = 160;
const COMPACT_NORMALIZATION_INPUT_CODE_POINTS = 1_024;

type SummaryCandidate = {
  readonly key: string;
  readonly signature: string;
  readonly text: string;
};

type Presentation = {
  readonly current: SummaryCandidate;
  readonly previous?: SummaryCandidate;
};

export function ReasoningSummaryStatus({
  snapshot,
  livePresentation,
  interactionTakeover,
}: {
  readonly snapshot: NormalizedThreadSnapshot;
  readonly livePresentation: boolean;
  readonly interactionTakeover: boolean;
}): React.JSX.Element | null {
  const chatVisible = useContext(ChatViewVisibilityContext);
  const activeTurnId = snapshot.activeTurnId;
  const activeTurn = activeTurnId
    ? snapshot.turnsById[activeTurnId]
    : undefined;
  const candidate = useMemo(() => latestSummaryCandidate(snapshot), [snapshot]);
  const eligible =
    chatVisible &&
    livePresentation &&
    !interactionTakeover &&
    activeTurn?.status === "in_progress" &&
    (snapshot.runState === "starting" ||
      snapshot.runState === "running" ||
      snapshot.runState === "stopping");

  const initialized = useRef(false);
  const observedTurnId = useRef<string | undefined>(undefined);
  const observedSignature = useRef<string | undefined>(undefined);
  const currentRef = useRef<SummaryCandidate | undefined>(undefined);
  const crossfadeTimer = useRef<number | undefined>(undefined);
  const [claimedTurnId, setClaimedTurnId] = useState<string>();
  const [presentation, setPresentation] = useState<Presentation>();
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const clearPresentation = () => {
    currentRef.current = undefined;
    setClaimedTurnId(undefined);
    setPresentation(undefined);
    setVisible(false);
    setPopoverOpen(false);
    setAnnouncement("");
    if (crossfadeTimer.current !== undefined) {
      window.clearTimeout(crossfadeTimer.current);
      crossfadeTimer.current = undefined;
    }
  };

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      observedTurnId.current = activeTurnId;
      observedSignature.current = candidate?.signature;
      return;
    }

    const turnChanged = observedTurnId.current !== activeTurnId;
    const candidateChanged = observedSignature.current !== candidate?.signature;
    observedTurnId.current = activeTurnId;
    // Hidden states still consume every revision, preventing a stale summary
    // from materializing when Chat or the live edge becomes visible again.
    observedSignature.current = candidate?.signature;

    if (!eligible || !activeTurnId) {
      clearPresentation();
      return;
    }
    if (turnChanged) clearPresentation();
    if ((!candidateChanged && !turnChanged) || !candidate) return;

    if (crossfadeTimer.current !== undefined) {
      window.clearTimeout(crossfadeTimer.current);
      crossfadeTimer.current = undefined;
    }
    const prior = currentRef.current;
    currentRef.current = candidate;
    setClaimedTurnId(activeTurnId);
    setPresentation({
      current: candidate,
      ...(prior && prior.key !== candidate.key ? { previous: prior } : {}),
    });
    setVisible(true);
    if (prior && prior.key !== candidate.key) {
      crossfadeTimer.current = window.setTimeout(() => {
        setPresentation((value) =>
          value ? { current: value.current } : value,
        );
        crossfadeTimer.current = undefined;
      }, CROSSFADE_MILLISECONDS);
    }
  }, [activeTurnId, candidate, eligible]);

  useEffect(
    () => () => {
      if (crossfadeTimer.current !== undefined) {
        window.clearTimeout(crossfadeTimer.current);
      }
    },
    [],
  );

  const paused = hovered || focused || popoverOpen;
  useEffect(() => {
    if (!visible || paused || !presentation) return undefined;
    const timer = window.setTimeout(
      () => setVisible(false),
      DISPLAY_MILLISECONDS,
    );
    return () => window.clearTimeout(timer);
  }, [paused, presentation, visible]);

  useEffect(() => {
    if (!eligible || !visible || !presentation) {
      setAnnouncement("");
      return undefined;
    }
    const timer = window.setTimeout(
      () => setAnnouncement(compactSummary(presentation.current.text)),
      ANNOUNCEMENT_DEBOUNCE_MILLISECONDS,
    );
    return () => window.clearTimeout(timer);
  }, [eligible, presentation, visible]);

  if (!eligible || !claimedTurnId || !presentation) return null;

  return (
    <div
      className="reasoning-summary-status-slot"
      data-visible={visible ? "true" : "false"}
      data-testid="reasoning-summary-status"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            aria-hidden={visible ? undefined : true}
            aria-label="Show full reasoning summary"
            className="reasoning-summary-status-trigger"
            tabIndex={visible ? 0 : -1}
            type="button"
          >
            <span aria-hidden="true" className="reasoning-summary-status-dot" />
            <span className="reasoning-summary-status-text-stack">
              {presentation.previous && (
                <span
                  aria-hidden="true"
                  className="reasoning-summary-status-text outgoing"
                >
                  {compactSummary(presentation.previous.text)}
                </span>
              )}
              <span
                aria-hidden="true"
                className={`reasoning-summary-status-text${
                  presentation.previous ? " incoming" : ""
                }`}
              >
                {compactSummary(presentation.current.text)}
              </span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Reasoning summary"
          className="reasoning-summary-status-popover"
          data-testid="reasoning-summary-popover"
          role="dialog"
          side="top"
          sideOffset={8}
        >
          <MarkdownContent enableMermaid={false} streaming={false}>
            {presentation.current.text}
          </MarkdownContent>
        </PopoverContent>
      </Popover>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {announcement}
      </span>
    </div>
  );
}

function latestSummaryCandidate(
  snapshot: NormalizedThreadSnapshot,
): SummaryCandidate | undefined {
  const activeTurnId = snapshot.activeTurnId;
  if (!activeTurnId) return undefined;
  const turn = snapshot.turnsById[activeTurnId];
  if (!turn || turn.status !== "in_progress") return undefined;

  for (
    let itemIndex = turn.orderedItemIds.length - 1;
    itemIndex >= 0;
    itemIndex -= 1
  ) {
    const item = snapshot.itemsById[turn.orderedItemIds[itemIndex]!];
    if (
      !item ||
      (item.kind !== "reasoning" &&
        !(
          item.kind === "activity_summary" && item.activityKind === "reasoning"
        ))
    ) {
      continue;
    }
    const parts = item.summaryParts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const text = parts[partIndex]?.text ?? "";
      if (!text.trim()) continue;
      const key = `${item.id}:${partIndex}`;
      return {
        key,
        signature: `${key}:${text}`,
        text,
      };
    }
  }
  return undefined;
}

function compactSummary(text: string): string {
  const characters = [
    ...markdownSummaryToPlainText(
      unicodeCodePointPrefix(text, COMPACT_NORMALIZATION_INPUT_CODE_POINTS),
    )
      .replace(/\s+/g, " ")
      .trim(),
  ];
  if (characters.length <= COMPACT_SUMMARY_MAX_CHARACTERS) {
    return characters.join("");
  }
  return `${characters
    .slice(0, COMPACT_SUMMARY_MAX_CHARACTERS - 1)
    .join("")
    .trimEnd()}…`;
}

function unicodeCodePointPrefix(
  text: string,
  maximumCodePoints: number,
): string {
  let codePoints = 0;
  let codeUnits = 0;
  for (const character of text) {
    if (codePoints >= maximumCodePoints) break;
    codePoints += 1;
    codeUnits += character.length;
  }
  return text.slice(0, codeUnits);
}

/**
 * Compact status is deliberately plain text. This covers the inline syntax
 * Codex summaries commonly use while the expanded surface remains the
 * authoritative Markdown rendering.
 */
function markdownSummaryToPlainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/\*\*([\s\S]*?)\*\*/g, "$1")
    .replace(/~~([\s\S]*?)~~/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])__([\s\S]*?)__(?=$|[^\p{L}\p{N}])/gu, "$1$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?=$|[^\p{L}\p{N}])/gu, "$1$2")
    .replace(/^[\t ]{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1");
}
