import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/ApiClient.js";
import type { UsageAnalyticsRequest, UsageAnalyticsResponse, UsageFacetRequest, UsageFacetResponse } from "../../shared/protocol/usage-analytics.js";

export const USAGE_REFRESH_MILLISECONDS = 60_000;
const AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS = 5_000;

interface UsageReadState<Response> {
  readonly data: Response | undefined;
  /** The data belongs to an earlier request while a new one loads. */
  readonly stale: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => void;
}

export type UsageAnalyticsState = UsageReadState<UsageAnalyticsResponse>;
const readAnalytics = (api: Pick<ApiClient, "getUsageAnalytics">, request: UsageAnalyticsRequest, signal: AbortSignal) => api.getUsageAnalytics(request, signal);
const readFacets = (api: Pick<ApiClient, "getUsageFacets">, request: UsageFacetRequest, signal: AbortSignal) => api.getUsageFacets(request, signal);

export function useUsageAnalytics(
  api: Pick<ApiClient, "getUsageAnalytics"> | undefined, key: string | null, build: () => UsageAnalyticsRequest,
  options: { readonly poll?: boolean } = {},
): UsageAnalyticsState {
  return useUsageRead(api, key, build, readAnalytics, options);
}

export function useUsageFacets(
  api: Pick<ApiClient, "getUsageFacets"> | undefined, key: string | null, build: () => UsageFacetRequest,
): UsageReadState<UsageFacetResponse> {
  return useUsageRead(api, key, build, readFacets);
}

/**
 * Single-flight analytics reads keyed by `key`. `build` runs per fetch so
 * ranges ending "now" advance on refresh. Results for superseded keys are
 * discarded; a failed refresh keeps the last successful display.
 * Automatic triggers share a five-second cooldown from the last read's start;
 * manual refreshes bypass it. In-flight reads younger than one minute satisfy
 * either trigger; older reads are superseded so a hung connection can recover.
 */
function useUsageRead<Api, Request, Response>(
  api: Api | undefined, key: string | null, build: () => Request,
  read: (api: Api, request: Request, signal: AbortSignal) => Promise<Response>,
  options: { readonly poll?: boolean } = {},
): UsageReadState<Response> {
  const [state, setState] = useState<{ owner?: Api; data?: Response; dataKey?: string; loading: boolean; error?: string }>({ owner: api, loading: !!api && key !== null });
  const buildRef = useRef(build);
  buildRef.current = build;
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const lastReadStartedAt = useRef<number | undefined>(undefined);
  const fetchNow = useCallback(() => {
    if (!api || key === null) return;
    if (controller.current) {
      if (lastReadStartedAt.current !== undefined && Date.now() - lastReadStartedAt.current < USAGE_REFRESH_MILLISECONDS) return;
      controller.current.abort();
    }
    const abort = new AbortController();
    controller.current = abort;
    lastReadStartedAt.current = Date.now();
    const current = ++generation.current;
    setState((previous) => previous.owner === api ? { ...previous, loading: true } : { owner: api, loading: true });
    let pending: Promise<Response>;
    // Building or validating the request can throw synchronously; report it like a failed read.
    try { pending = read(api, buildRef.current(), abort.signal); } catch (error) {
      controller.current = undefined;
      lastReadStartedAt.current = undefined;
      setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Invalid usage query." }));
      return;
    }
    pending.then((data) => {
      if (current !== generation.current) return;
      controller.current = undefined;
      setState({ owner: api, data, dataKey: key, loading: false });
    }, (error: unknown) => {
      if (current !== generation.current || abort.signal.aborted) return;
      controller.current = undefined;
      lastReadStartedAt.current = undefined;
      setState((previous) => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "Usage is unavailable." }));
    });
  }, [api, key, read]);

  useEffect(() => {
    if (!api) setState({ loading: false });
    else if (key === null) setState((previous) => ({ ...previous, loading: false }));
    else fetchNow();
    return () => {
      controller.current?.abort();
      controller.current = undefined;
      lastReadStartedAt.current = undefined;
      generation.current += 1;
    };
  }, [api, fetchNow, key]);

  useEffect(() => {
    if (!api || !options.poll || key === null) return;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const wake = () => {
      if (!visible()) return;
      if (lastReadStartedAt.current !== undefined && Date.now() - lastReadStartedAt.current < AUTOMATIC_REFRESH_COOLDOWN_MILLISECONDS) return;
      fetchNow();
    };
    const interval = window.setInterval(wake, USAGE_REFRESH_MILLISECONDS);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [api, fetchNow, key, options.poll]);

  // Hide another connection's result during render, before effects start its replacement read.
  const sameOwner = state.owner === api;
  return { data: sameOwner ? state.data : undefined, stale: !sameOwner || state.dataKey !== key,
    loading: sameOwner ? state.loading : !!api && key !== null, error: sameOwner ? state.error : undefined, refresh: fetchNow };
}
