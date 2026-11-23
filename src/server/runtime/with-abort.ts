/** Stop waiting on shared work when this consumer leaves. */
export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([aborted, promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
