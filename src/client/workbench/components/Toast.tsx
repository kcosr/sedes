import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export interface ToastOptions {
  /** error: red, shown longer. success: adds a check icon. */
  tone?: "default" | "success" | "error" | undefined;
  /**
   * Milliseconds (default 2200; errors 4000; with an action 6000). The
   * timer pauses while the pointer is over the toast or focus is inside it.
   */
  duration?: number | undefined;
  action?: { label: string; onClick: () => void } | undefined;
}

export type ToastFn = (message: ReactNode, options?: ToastOptions) => void;

const ToastContext = createContext<ToastFn>(() => {});

/** Show a toast: `const toast = useToast(); toast("Token revoked")`. */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  message: ReactNode;
  tone: NonNullable<ToastOptions["tone"]>;
  action: ToastOptions["action"];
  duration: number;
}

/** After a pause at least this much time is left, so brushing past doesn't dismiss at once. */
const RESUME_MIN = 1000;

/**
 * An inverted bottom toast; one at a time, the newest replaces the
 * previous. Hovering or focusing a toast pauses its timer (WCAG 2.2.1) and
 * Esc dismisses it while focus is inside; it never takes focus itself.
 */
export function ToastProvider({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const host = useRef<HTMLDivElement | null>(null);
  // Where focus was before it entered a toast (its action button).
  const returnTo = useRef<HTMLElement | null>(null);

  /** A toast with focus inside is going: hand focus back to where it came from. */
  const release = useCallback(() => {
    if (!host.current?.contains(document.activeElement)) return;
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      release();
      setToasts((ts) => ts.filter((t) => t.id !== id));
    },
    [release],
  );

  const toast = useCallback<ToastFn>(
    (message, options = {}) => {
      const id = ++seq.current;
      const tone = options.tone ?? "default";
      const duration =
        options.duration ??
        (options.action ? 6000 : tone === "error" ? 4000 : 2200);
      release();
      setToasts([{ id, message, tone, action: options.action, duration }]);
    },
    [release],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        ref={host}
        className="wb-toast-host"
        role="status"
        aria-live="polite"
        onFocus={(e) => {
          const from = e.relatedTarget as HTMLElement | null;
          if (!e.currentTarget.contains(from)) returnTo.current = from;
        }}
      >
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const left = useRef(item.duration);

  // Runs while not held; a pause keeps the time that was left.
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(item.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(
        Math.min(RESUME_MIN, item.duration),
        left.current - (Date.now() - started),
      );
    };
  }, [held, item.id, item.duration, onDismiss]);

  return (
    <div
      className={cx("wb-toast", item.tone === "error" && "wb-toast--error")}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
        // Ours, not the layer stack's (a drawer behind stays open).
        e.preventDefault();
        e.stopPropagation();
        onDismiss(item.id);
      }}
    >
      {item.tone === "success" ? (
        <Icon name="check" />
      ) : item.tone === "error" ? (
        <Icon name="alert-circle" />
      ) : null}
      <span>{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className="wb-toast-action"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
    </div>
  );
}
