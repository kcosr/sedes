/**
 * Cold thread reads and bounded history acquisitions can cross multiple SSH
 * hops and hydrate provider storage. Keep their budget separate from controls,
 * mutation receipts, and the short best-effort live-head refresh.
 */
export const CODEX_HISTORY_TIMEOUT_MILLISECONDS = 60_000;
