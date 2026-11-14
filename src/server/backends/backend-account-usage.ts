import type { BackendAccountUsage } from "../../shared/protocol/account-usage.js";

/** Backend-owned process-local observation; reading never starts provider work. */
export interface BackendAccountUsageSource {
  readonly supported: boolean;
  snapshot(): BackendAccountUsage | null;
  subscribe(listener: () => void): () => void;
}

/** Explicit disposition for backends without a native account-quota reader. */
export const NO_BACKEND_ACCOUNT_USAGE: BackendAccountUsageSource = Object.freeze({
  supported: false,
  snapshot: () => null,
  subscribe: () => () => undefined,
});
