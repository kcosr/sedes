/**
 * Most per-operation receipts a resident conversation handle keeps for
 * in-process replay. A handle that is evicted and reattached starts with
 * none, so a retained receipt is only a recency cache over the provider's own
 * durable evidence and the application's operation records.
 */
export const MAXIMUM_RESIDENT_OPERATION_RECEIPTS = 1_024;

/**
 * Records `value` as the newest receipt for `key`, then drops the oldest
 * receipts that `evictable` accepts until at most `limit` remain. Receipts it
 * rejects, such as an outcome that is still unknown, are never dropped: the
 * map exceeds `limit` only while that many of them remain unresolved.
 */
export function rememberBoundedReceipt<K, V>(
  receipts: Map<K, V>,
  key: NoInfer<K>,
  value: NoInfer<V>,
  evictable: (receipt: NoInfer<V>) => boolean = () => true,
  limit = MAXIMUM_RESIDENT_OPERATION_RECEIPTS,
): void {
  receipts.delete(key);
  receipts.set(key, value);
  if (receipts.size <= limit) return;
  for (const [candidate, receipt] of receipts) {
    if (receipts.size <= limit) return;
    if (candidate !== key && evictable(receipt)) receipts.delete(candidate);
  }
}
