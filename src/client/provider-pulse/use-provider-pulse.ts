import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import type { ProviderPulseStatus } from "../../shared/protocol/provider-pulse.js";

const OPEN_POLL_MS = 60_000;
const ACTION_POLL_MS = 800;
const ACTION_POLL_ATTEMPTS = 20;

export interface ProviderPulseController {
  readonly status: ProviderPulseStatus | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly checkingIds: ReadonlySet<string>;
  readonly snapshotting: boolean;
  load(): Promise<void>;
  stop(): void;
  checkAccount(accountId: string): Promise<void>;
  checkAll(): Promise<void>;
  snapshot(): Promise<void>;
}

export function useProviderPulse(
  api: ApiClient | undefined,
): ProviderPulseController {
  const [status, setStatus] = useState<ProviderPulseStatus>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [snapshotting, setSnapshotting] = useState(false);
  const statusRef = useRef<ProviderPulseStatus | undefined>(undefined);
  const openRef = useRef(false);
  const pollRef = useRef<number>(0);
  const inFlightRef = useRef<
    Promise<ProviderPulseStatus | undefined> | undefined
  >(undefined);

  const refresh = useCallback(async (): Promise<
    ProviderPulseStatus | undefined
  > => {
    if (!api) return undefined;
    try {
      const next = await api.readProviderPulseStatus();
      if (!openRef.current) return next;
      statusRef.current = next;
      setStatus(next);
      setError(undefined);
      return next;
    } catch (caught) {
      if (!openRef.current) return undefined;
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Provider Pulse is unavailable.",
      );
      return undefined;
    }
  }, [api]);

  const load = useCallback(async () => {
    if (!api) {
      setError("Provider Pulse is unavailable.");
      return;
    }
    openRef.current = true;
    if (!statusRef.current) setLoading(true);
    try {
      if (!inFlightRef.current) {
        inFlightRef.current = refresh().finally(() => {
          inFlightRef.current = undefined;
          setLoading(false);
        });
      }
      await inFlightRef.current;
    } finally {
      if (openRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = window.setInterval(() => {
          void refresh();
        }, OPEN_POLL_MS);
      }
    }
  }, [api, refresh]);

  const stop = useCallback(() => {
    openRef.current = false;
    window.clearInterval(pollRef.current);
    pollRef.current = 0;
  }, []);

  const pollUntilSettled = useCallback(
    async (accountIds: readonly string[]) => {
      for (let attempt = 0; attempt < ACTION_POLL_ATTEMPTS; attempt += 1) {
        if (!openRef.current) return;
        await new Promise((resolve) => {
          window.setTimeout(resolve, ACTION_POLL_MS);
        });
        if (!openRef.current) return;
        const current = await refresh();
        if (!current) continue;
        const pending = current.accounts.some(
          (account) =>
            accountIds.includes(account.id) && account.usage.inFlight,
        );
        if (!pending) return;
      }
    },
    [refresh],
  );

  const checkAccount = useCallback(
    async (accountId: string) => {
      if (!api) return;
      setCheckingIds((current) => new Set(current).add(accountId));
      try {
        await api.checkProviderPulseAccount(accountId);
        await pollUntilSettled([accountId]);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "The usage check could not be started.",
        );
      } finally {
        setCheckingIds((current) => {
          const next = new Set(current);
          next.delete(accountId);
          return next;
        });
      }
    },
    [api, pollUntilSettled],
  );

  const checkAll = useCallback(async () => {
    if (!api) return;
    const ids = status?.accounts.map((account) => account.id) ?? [];
    setCheckingIds(new Set(ids.length ? ids : ["*"]));
    try {
      const result = await api.checkAllProviderPulseAccounts();
      await pollUntilSettled(
        result.receipts.map((receipt) => receipt.targetId),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The usage check could not be started.",
      );
    } finally {
      setCheckingIds(new Set());
    }
  }, [api, pollUntilSettled, status]);

  const snapshot = useCallback(async () => {
    if (!api) return;
    setSnapshotting(true);
    try {
      const result = await api.snapshotProviderPulseUsage();
      setStatus((current) =>
        current ? { ...current, usageBaseline: result.usageBaseline } : current,
      );
      if (statusRef.current) {
        statusRef.current = {
          ...statusRef.current,
          usageBaseline: result.usageBaseline,
        };
      }
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The usage snapshot could not be saved.",
      );
    } finally {
      setSnapshotting(false);
    }
  }, [api, refresh]);

  useEffect(() => () => stop(), [stop]);

  return {
    status,
    error,
    loading,
    checkingIds,
    snapshotting,
    load,
    stop,
    checkAccount,
    checkAll,
    snapshot,
  };
}
