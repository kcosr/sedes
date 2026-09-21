import { useEffect, useRef, useState } from "react";
import type { ConversationTurn, NormalizedThreadSnapshot } from "../../../shared/index.js";

export function currentFailedTurn(snapshot: NormalizedThreadSnapshot): ConversationTurn | undefined {
  if (snapshot.runState !== "failed") return undefined;
  const latestId = snapshot.orderedTurnIds.at(-1);
  const latest = latestId ? snapshot.turnsById[latestId] : undefined;
  return latest?.status === "failed" ? latest : undefined;
}

export function ThreadFailureNotice({ snapshot }: { readonly snapshot: NormalizedThreadSnapshot }): React.JSX.Element {
  const turn = currentFailedTurn(snapshot);
  const failed = turn !== undefined;
  const message = turn?.failure?.message.text ?? "The turn failed. No error details are available.";
  const previous = useRef({ threadId: snapshot.thread.id, failed });
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const enteredFailure = previous.current.threadId === snapshot.thread.id && !previous.current.failed && failed;
    previous.current = { threadId: snapshot.thread.id, failed };
    setAnnouncement(enteredFailure ? message : "");
  }, [failed, message, snapshot.thread.id]);
  return <>
    {failed && <div className="thread-notice error"><strong>Turn failed</strong><div>{message}</div></div>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
  </>;
}

export function TurnFailureDetails({ turn }: { readonly turn: ConversationTurn }): React.JSX.Element | null {
  if (turn.status !== "failed") return null;
  return <details className="turn-failure-details">
    <summary>Failed turn details</summary>
    <p>{turn.failure?.message.text ?? "The turn failed. No error details are available."}</p>
  </details>;
}
