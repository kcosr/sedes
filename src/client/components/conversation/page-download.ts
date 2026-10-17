import { useLayoutEffect, useRef, useState } from "react";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import type { ItemRenderContext } from "./types.js";
import { startBrowserDownload } from "../../app/browser-download.js";
import { downloadInPackagedClient, supportsPackagedDownloads } from "../../app/packaged-download.js";

interface DownloadState {
  readonly key: string;
  readonly phase: "idle" | "preparing" | "started";
  readonly status?: string;
  readonly error?: string;
}

/** Page downloads never depend on the authored document or its frame lifecycle. */
export function usePageDownload(
  key: string,
  page: PageRevision,
  enabled: boolean,
  prepare: ItemRenderContext["preparePageDownload"],
  profileId: string,
) {
  const controller = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const currentKey = useRef<string | undefined>(undefined);
  currentKey.current = enabled ? key : undefined;
  const [state, setState] = useState<DownloadState>({ key, phase: "idle" });
  useLayoutEffect(() => {
    setState((current) => current.key === key && current.phase === "idle" &&
      !current.status && !current.error ? current : { key, phase: "idle" });
    return () => {
      controller.current?.abort();
      controller.current = undefined;
      busy.current = false;
      window.clearTimeout(timer.current);
    };
  }, [enabled, key, prepare, profileId]);

  const download = async () => {
    if (!enabled || !prepare || busy.current) return;
    controller.current?.abort();
    window.clearTimeout(timer.current);
    const request = new AbortController();
    controller.current = request;
    busy.current = true;
    const active = () => !request.signal.aborted && currentKey.current === key && controller.current === request;
    setState({ key, phase: "preparing" });
    try {
      // Capture immutable metadata and this connection's callback at the click.
      const prepared = await prepare(page, request.signal);
      if (!active()) return;
      if (supportsPackagedDownloads()) {
        const result = await downloadInPackagedClient({
          serverOrigin: prepared.serverOrigin,
          url: prepared.url,
          suggestedFileName: prepared.suggestedFileName,
          expectedContentDisposition: prepared.contentDisposition,
          expectedContentLength: prepared.contentLength,
          expectedRevision: prepared.revision,
          expectedProfileId: profileId,
          signal: request.signal,
        });
        if (!active()) return;
        busy.current = false;
        setState({ key, phase: "idle", status: result === "saved" ? "HTML saved." : undefined });
      } else {
        startBrowserDownload({
          url: prepared.url,
          signal: request.signal,
          failureMessage: "The HTML could not be downloaded. Try again.",
          redirectMessage: "The HTML download was redirected unexpectedly.",
          onFailure: (error) => {
            if (!active()) return;
            window.clearTimeout(timer.current);
            busy.current = false;
            setState({ key, phase: "idle", error });
          },
        });
        setState({ key, phase: "started", status: "Download started." });
        timer.current = window.setTimeout(() => {
          if (!active()) return;
          busy.current = false;
          setState((value) => value.key === key && value.phase === "started" ? { ...value, phase: "idle" } : value);
        }, 1_500);
      }
    } catch (error) {
      if (!active()) return;
      busy.current = false;
      setState({ key, phase: "idle", error: error instanceof Error ? error.message : "The HTML could not be downloaded. Try again." });
    }
  };
  const visibleState: DownloadState = enabled && state.key === key ? state : { key, phase: "idle" };
  return { ...visibleState, download };
}
