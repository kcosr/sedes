import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** A long transcript must not keep an unbounded collection of scripts alive. */
export class PageFrameBudget {
  readonly #entries = new Map<
    symbol,
    {
      requested: boolean;
      priority: number;
      foreground: boolean;
      admitted: boolean;
      update: (admitted: boolean) => void;
    }
  >();
  #sequence = 0;
  constructor(readonly limit = 4) {}

  register(update: (admitted: boolean) => void): symbol {
    const id = Symbol();
    this.#entries.set(id, {
      requested: false,
      priority: 0,
      foreground: false,
      admitted: false,
      update,
    });
    return id;
  }

  request(id: symbol, requested: boolean, foreground = false): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (requested && (!entry.requested || foreground))
      entry.priority = ++this.#sequence;
    entry.requested = requested;
    entry.foreground = foreground;
    this.#reconcile();
  }

  remove(id: symbol): void {
    this.#entries.delete(id);
    this.#reconcile();
  }

  #reconcile(): void {
    const active = new Set(
      [...this.#entries]
        .filter(([, entry]) => entry.requested)
        .sort(
          (a, b) =>
            Number(b[1].foreground) - Number(a[1].foreground) ||
            b[1].priority - a[1].priority,
        )
        .slice(0, this.limit)
        .map(([id]) => id),
    );
    for (const [id, entry] of this.#entries) {
      const admitted = active.has(id);
      if (entry.admitted === admitted) continue;
      entry.admitted = admitted;
      entry.update(admitted);
    }
  }
}

const frameBudget = new PageFrameBudget();
const RETENTION_MS = 30_000;

/** A navigation retains its WindowProxy; trusted DOM reparenting creates one. */
export class PageFrameLoadGuard {
  #context: Window | undefined;

  reset(): void {
    this.#context = undefined;
  }

  accept(context: Window | null): "initial" | "replacement" | "rejected" {
    if (!context || context === this.#context) return "rejected";
    const result = this.#context === undefined ? "initial" : "replacement";
    this.#context = context;
    return result;
  }
}

export function usePageFrameAdmission(
  target: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  foreground: boolean,
  automatic: boolean,
): { admitted: boolean; visible: boolean; request: () => void } {
  const [admitted, setAdmitted] = useState(false);
  const [requested, setRequested] = useState(false);
  const [activation, setActivation] = useState(0);
  const [visible, setVisible] = useState(false);
  const [retained, setRetained] = useState(false);
  const retentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const admittedRef = useRef(false);
  admittedRef.current = admitted;
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const id = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    id.current = frameBudget.register(setAdmitted);
    return () => {
      if (id.current) frameBudget.remove(id.current);
      id.current = undefined;
    };
  }, []);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.some((entry) => entry.isIntersecting);
        setVisible(intersecting);
        clearTimeout(retentionTimer.current);
        // Update visibility and retention together so there is no intermediate
        // render that tears down the frame while starting its grace period.
        if (intersecting) setRetained(false);
        else {
          setRequested(false);
          setRetained(admittedRef.current);
          retentionTimer.current = setTimeout(
            () => setRetained(false),
            RETENTION_MS,
          );
        }
      },
      { rootMargin: "256px 0px" },
    );
    observer.observe(element);
    return () => {
      clearTimeout(retentionTimer.current);
      observer.disconnect();
    };
  }, [target]);

  useEffect(() => {
    const onVisibility = () =>
      setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled || !documentVisible) {
      clearTimeout(retentionTimer.current);
      setRetained(false);
      setRequested(false);
    }
  }, [enabled, documentVisible]);

  useEffect(() => {
    if (id.current)
      frameBudget.request(
        id.current,
        enabled &&
          documentVisible &&
          (requested || retained || (automatic && (visible || foreground))),
        foreground || requested || visible,
      );
  }, [
    activation,
    automatic,
    documentVisible,
    enabled,
    foreground,
    requested,
    retained,
    visible,
  ]);

  const request = useCallback(() => {
    setRequested(true);
    setActivation((value) => value + 1);
  }, []);
  return {
    admitted: admitted && enabled && documentVisible,
    visible: visible || foreground,
    request,
  };
}
