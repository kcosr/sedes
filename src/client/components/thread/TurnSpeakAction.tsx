import { Check, LoaderCircle, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SelectedAssistantResult } from "../../../shared/protocol/notification.js";
import { PAYLOAD_LIMITS, type BoundedText } from "../../../shared/protocol/payload.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import type { NativeVoiceStore, VoiceClientState } from "../../voice/NativeVoiceStore.js";
import { useNativeVoice } from "../../voice/VoiceProvider.js";
import { canEnableVoice } from "../../voice/voice-session.js";

type ReplySource = Pick<ThreadClientStore, "threadId" | "readTurnReplySpeech">;
type Feedback =
  | { readonly kind: "idle" | "pending" }
  | { readonly kind: "queued" | "failed"; readonly message: string };

/**
 * Android only: queues an ended turn's reply for native speech. It renders only
 * while voice is on and speech is configured. Its hooks live here so the turn
 * footer's hook order never depends on voice availability.
 */
export function TurnSpeakAction({ store, turnId, copyText }: {
  readonly store: ReplySource;
  readonly turnId: string;
  readonly copyText: string | undefined;
}): React.JSX.Element | null {
  const voice = useNativeVoice();
  if (!voice || !copyText) return null;
  return <VoiceTurnSpeak voice={voice} store={store} turnId={turnId} copyText={copyText} />;
}

function VoiceTurnSpeak({ voice, store, turnId, copyText }: {
  readonly voice: NativeVoiceStore;
  readonly store: ReplySource;
  readonly turnId: string;
  readonly copyText: string;
}): React.JSX.Element | null {
  // A primitive snapshot: unrelated voice progress does not re-render every footer.
  const speaks = useSyncExternalStore(voice.subscribe, () => voiceSpeaks(voice.getSnapshot()));
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle" });
  const inFlight = useRef(false);
  useEffect(() => {
    if (feedback.kind !== "queued" && feedback.kind !== "failed") return undefined;
    const timer = window.setTimeout(() => setFeedback({ kind: "idle" }), 1800);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  if (!speaks) return null;

  const play = async () => {
    // A ref, not state: a second tap that arrives before the pending render is ignored too.
    if (inFlight.current) return;
    inFlight.current = true;
    setFeedback({ kind: "pending" });
    try {
      let assistantResult: SelectedAssistantResult;
      try {
        assistantResult = replySpeechText((await store.readTurnReplySpeech(turnId)).assistantResult, copyText);
      } catch {
        // No fallback: a server outage stays visible instead of reading different text.
        setFeedback({ kind: "failed", message: "Couldn't load the response to play" });
        return;
      }
      const before = voice.getSnapshot().native;
      const idle = before?.active === null && before.queue.count === 0;
      try {
        await voice.speakReply({ threadId: store.threadId, turnId, assistantResult });
        setFeedback({ kind: "queued", message: idle ? "Playing" : "Queued to play" });
      } catch (error) {
        setFeedback({ kind: "failed", message: speakFailure(error) });
      }
    } finally {
      inFlight.current = false;
    }
  };

  const pending = feedback.kind === "pending";
  return (
    <>
      <button
        type="button"
        className="turn-fork-action"
        aria-label="Play response aloud"
        title="Play response aloud"
        aria-busy={pending || undefined}
        onClick={() => void play()}
      >
        {pending ? (
          <LoaderCircle className="turn-fork-spinner" size={16} aria-hidden="true" />
        ) : feedback.kind === "queued" ? (
          <Check size={16} aria-hidden="true" />
        ) : feedback.kind === "failed" ? (
          <X size={16} aria-hidden="true" />
        ) : (
          <Volume2 size={16} aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" role="status">
        {feedback.kind === "queued" || feedback.kind === "failed" ? feedback.message : ""}
      </span>
    </>
  );
}

/** Manual or Response mode with speech configured; native reports every other readiness gap when tapped. */
function voiceSpeaks({ native }: VoiceClientState): boolean {
  return native !== undefined && native.settings.audioMode !== "off" &&
    canEnableVoice(native.settings, native.speech.credentialConfigured);
}

const speakFailures: Readonly<Record<string, string>> = {
  voice_not_ready: "Voice isn't ready",
  voice_reply_empty: "This response has nothing to read aloud",
  voice_queue_full: "The voice queue is full",
};
function speakFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return (typeof code === "string" ? speakFailures[code] : undefined) ??
    (error instanceof Error && error.message ? error.message : "Playing the response failed");
}

const hasText = (section: BoundedText | null | undefined) => Boolean(section?.text.trim());
/** The stored completion text voice would have read; without any, the whole reply as Copy response gives it. */
export function replySpeechText(stored: SelectedAssistantResult | null, copyText: string): SelectedAssistantResult {
  return stored && (hasText(stored.provisional) || hasText(stored.unclassified) || hasText(stored.final))
    ? stored
    : { unclassified: boundedReplyText(copyText) };
}

const ELLIPSIS = "…";
const utf8 = new TextEncoder();
/** Fits `boundedTextSchema`: a whole-code-point prefix marked with an ellipsis and its truncation, as server bounded text is. */
export function boundedReplyText(text: string): BoundedText {
  if (text.length <= PAYLOAD_LIMITS.textCharacters) return { text };
  let end = PAYLOAD_LIMITS.textCharacters - ELLIPSIS.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const kept = `${text.slice(0, end)}${ELLIPSIS}`;
  return { text: kept, truncation: { truncated: true, retainedBytes: utf8.encode(kept).byteLength, reason: "byte_limit" } };
}
