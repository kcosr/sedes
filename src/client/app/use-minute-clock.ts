import { useEffect, useState } from "react";

/**
 * Wall-clock time that advances on each minute boundary, for pages that show
 * relative ages, future times and date buckets (the Archived and Automations
 * pages).
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(1_000, 60_010 - (Date.now() % 60_000)),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}
