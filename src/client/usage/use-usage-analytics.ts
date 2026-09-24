import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/ApiClient.js";
import type { UsageAnalyticsRequest, UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";

export const USAGE_REFRESH_MILLISECONDS = 60_000;

export interface UsageAnalyticsState {
  readonly data: UsageAnalyticsResponse | undefined;
  /** The data belongs to an earlier request while a new one loads. */
  readonly stale: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => void;
}

/**
 * Single-flight analytics reads keyed by `key`. `build` runs per fetch so
 * ranges ending "now" advance on refresh. Results for superseded keys are
 * discarded; a failed refresh keeps the last successful display.
 */
export function useUsageAnalytics(
  api: Pick<ApiClient, "getUsageAnalytics"> | undefined, key: string | null, build: () => UsageAnalyticsRequest,
  options: { readonly poll?: boolean } = {},
): UsageAnalyticsState {
  const [state, setState] = useState<{ data?: UsageAnalyticsResponse; dataKey?: string; loading: boolean; error?: string }>({ loading: key !== null });
  const buildRef = useRef(build);
  buildRef.current = build;
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const fetchNow = useCallback(() => {
    if (!api || key === null) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    setState((previous) => ({ ...previous, loading: true }));
    let pending: Promise<UsageAnalyticsResponse>;
    // Building or validating the request can throw synchronously; report it like a failed read.
    try { pending = api.getUsageAnalytics(buildRef.current(), abort.signal); } catch (error) {
      setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Invalid usage query." }));
      return;
    }
    pending.then((data) => {
      if (current !== generation.current) return;
      setState({ data, dataKey: key, loading: false });
    }, (error: unknown) => {
      if (current !== generation.current || abort.signal.aborted) return;
      setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Usage is unavailable." }));
    });
  }, [api, key]);

  useEffect(() => {
    fetchNow();
    return () => { controller.current?.abort(); generation.current += 1; };
  }, [fetchNow]);

  useEffect(() => {
    if (!options.poll || key === null) return;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const interval = window.setInterval(() => { if (visible()) fetchNow(); }, USAGE_REFRESH_MILLISECONDS);
    const wake = () => { if (visible()) fetchNow(); };
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [fetchNow, key, options.poll]);

  return { data: state.data, stale: state.dataKey !== key, loading: state.loading, error: state.error, refresh: fetchNow };
}
