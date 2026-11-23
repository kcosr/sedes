import { useEffect, useRef, useState } from "react";

export function useClipboardCopy() {
  const [feedback, setFeedback] = useState<{ state: "copied" | "failed" }>();
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 1_800);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy(text: string): Promise<void> {
    const request = ++latestRequest.current;
    let state: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      state = "failed";
    }
    if (request === latestRequest.current) setFeedback({ state });
  }

  return { copy, copyState: feedback?.state ?? "idle" } as const;
}
