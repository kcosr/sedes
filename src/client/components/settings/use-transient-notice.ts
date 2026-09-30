import { useCallback, useEffect, useRef, useState } from "react";

/** How long a success notice ("Prompt saved.") stays. */
export const TRANSIENT_NOTICE_MS = 3000;

/**
 * A success notice that clears itself, and clears with the component on
 * navigation. Errors are not transient; they stay until the next attempt.
 */
export function useTransientNotice(): readonly [
  notice: string,
  show: (message: string) => void,
  clear: () => void,
] {
  const [notice, setNotice] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setNotice("");
  }, []);
  const show = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setNotice(message);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setNotice("");
    }, TRANSIENT_NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [notice, show, clear] as const;
}
