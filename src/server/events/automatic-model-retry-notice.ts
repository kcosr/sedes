import type { ThreadEventHub } from "./thread-event-hub.js";

/** Keeps the retry delay visible across initial binding and projection replacement. */
export function showAutomaticModelRetryNotice(hub: ThreadEventHub): () => void {
  let closed = false;
  let scheduled = false;
  let publishedGeneration: string | undefined;
  let publishedNotice: { generation: string; noticeId: string } | undefined;
  const schedule = () => {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const generation = hub.projectionGeneration;
      if (closed || !generation || !hub.snapshot || generation === publishedGeneration) return;
      publishedGeneration = generation;
      const envelope = hub.publish({
        type: "notice",
        generation,
        notice: {
          id: "automatic-model-retry",
          tone: "info",
          message: { text: "Retrying in 10 seconds…" },
          createdAt: new Date().toISOString(),
        },
      });
      if (envelope?.event.type === "notice") {
        publishedNotice = { generation, noticeId: envelope.event.notice.id };
        // Stop may run synchronously inside publication fanout.
        if (closed) hub.dismissNotice(publishedNotice);
      }
    });
  };
  const subscription = hub.subscribeInternal(({ event }) => {
    if (event.type === "snapshot") schedule();
  });
  schedule();
  return () => {
    if (closed) return;
    closed = true;
    subscription.close();
    if (publishedNotice) hub.dismissNotice(publishedNotice);
  };
}
