import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import {
  OverlayScope,
  useFocusTrap,
  useLayer,
  useOverlayOwner,
} from "../lib/layers";
import { Button, IconButton } from "./Button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** sm 440px (confirmations, prompts), md 560px (default), lg 760px. */
  size?: "sm" | "md" | "lg" | undefined;
  children?: ReactNode;
  /** Sticky footer, right-aligned (put the primary action last). */
  footer?: ReactNode;
  /** Muted text at the left of the footer. */
  footerNote?: ReactNode;
  /** Extra header content (e.g. a Seg) between the title and the × button. */
  headerExtra?: ReactNode;
  /** Render the dialog as a <form>; footer submit buttons then submit it. */
  onSubmit?: ((e: FormEvent<HTMLFormElement>) => void) | undefined;
  /** Esc, scrim click and × close it (default true). Turn off while saving. */
  dismissible?: boolean | undefined;
  /** Close when the scrim is clicked (default true). */
  closeOnScrim?: boolean | undefined;
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /**
   * "alertdialog" for urgent interruptions that need a response
   * (ConfirmDialog uses it); the body then describes the dialog.
   */
  role?: "dialog" | "alertdialog" | undefined;
  className?: string | undefined;
}

/** Modal dialog: scrim, focus trap, sticky header/footer, scrolling body. */
export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalSurface {...props} />;
}

function ModalSurface({
  onClose,
  title,
  description,
  size = "md",
  children,
  footer,
  footerNote,
  headerExtra,
  onSubmit,
  dismissible = true,
  closeOnScrim = true,
  initialFocusRef,
  role = "dialog",
  className,
}: ModalProps) {
  const box = useRef<HTMLElement | null>(null);
  const titleId = `wb-modal-${useId()}`;
  const descId = description ? `${titleId}-desc` : undefined;
  // An alert dialog is described by its message (the body).
  const bodyId = `${titleId}-body`;
  const describedBy =
    [descId, role === "alertdialog" && children ? bodyId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const dismiss = () => {
    if (dismissible) onClose();
  };
  const root = useRef<HTMLDivElement | null>(null);
  const layers = useLayer(true, dismiss, true, root);
  // The owner covers the scrim too, so ancestor overlays leave its clicks alone.
  const owner = useOverlayOwner(root);
  useFocusTrap(box, true, { initialFocus: initialFocusRef, owner, layers });

  const content = (
    <>
      <div className="wb-modal-head">
        <div className="wb-modal-titles">
          <h2 className="wb-modal-title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="wb-modal-desc" id={descId}>
              {description}
            </p>
          ) : null}
        </div>
        {headerExtra}
        <IconButton
          icon="x"
          label="Close"
          title="Close (Esc)"
          onClick={dismiss}
          disabled={!dismissible}
        />
      </div>
      <div className="wb-modal-body" id={bodyId}>
        {children}
      </div>
      {footer || footerNote ? (
        <div className="wb-modal-foot">
          {footerNote ? (
            <span className="wb-modal-foot-note">{footerNote}</span>
          ) : null}
          {footer}
        </div>
      ) : null}
    </>
  );

  const shared = {
    className: cx("wb-modal", size !== "md" && `wb-modal--${size}`, className),
    role,
    "aria-modal": true,
    "aria-labelledby": titleId,
    "aria-describedby": describedBy,
    tabIndex: -1,
  } as const;

  return createPortal(
    <OverlayScope layers={layers} owner={owner}>
      <div ref={root}>
        <div
          className="wb-scrim"
          aria-hidden="true"
          onClick={closeOnScrim ? dismiss : undefined}
        />
        {onSubmit ? (
          <form
            {...shared}
            ref={(el) => {
              box.current = el;
            }}
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
            noValidate
          >
            {content}
          </form>
        ) : (
          <div
            {...shared}
            ref={(el) => {
              box.current = el;
            }}
          >
            {content}
          </div>
        )}
      </div>
    </OverlayScope>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** What will happen; name the object. */
  children?: ReactNode;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** danger (default) focuses Cancel first; primary focuses the confirm button. */
  tone?: "danger" | "primary" | undefined;
  /** May return a promise: the dialog shows pending, closes on success, shows the error on failure. */
  onConfirm: () => void | Promise<unknown>;
}

/** The one confirmation pattern: small modal, async confirm with pending and error states. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <ConfirmSurface {...props} />;
}

function ConfirmSurface({
  onClose,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const confirm = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onConfirm();
      if (mounted.current) onClose();
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };

  return (
    <ModalSurface
      open
      onClose={onClose}
      title={title}
      role="alertdialog"
      size="sm"
      dismissible={!pending}
      initialFocusRef={tone === "danger" ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === "danger" ? "danger" : "primary"}
            pending={pending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <div className="wb-form-error" role="alert">
          {error}
        </div>
      ) : null}
    </ModalSurface>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  /** What will happen; name the object. */
  body?: ReactNode;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** danger (default) focuses Cancel first; primary focuses the confirm button. */
  tone?: "danger" | "primary" | undefined;
  /**
   * Runs on confirm. The dialog stays open and pending until it settles; if
   * it throws, the dialog shows the error and the user can retry or cancel.
   */
  action?: (() => void | Promise<unknown>) | undefined;
}

/**
 * Ask for confirmation. Resolves true once confirmed (after `action`
 * succeeded), false when cancelled, after the dialog has closed and
 * returned focus.
 */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
  /** The action succeeded (or there was none): resolve true. */
  ok: boolean;
  running: boolean;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

const noConfirmProvider: ConfirmFn = () =>
  Promise.reject(new Error("useConfirm() needs a <ConfirmProvider> above it"));

/**
 * `const confirm = useConfirm(); if (await confirm({ title, action })) …`.
 * Needs a ConfirmProvider; without one the promise rejects.
 */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? noConfirmProvider;
}

/**
 * Hosts the dialogs for useConfirm(): one ConfirmDialog at a time, further
 * requests wait their turn. Put it once near the root (inside LinkProvider
 * and ToastProvider if actions use them).
 */
export function ConfirmProvider({ children }: { children?: ReactNode }) {
  const [queue, setQueue] = useState<readonly ConfirmRequest[]>([]);
  // One render with no dialog after each close: the closed dialog unmounts
  // and returns focus to its opener before the next one mounts, so the next
  // takes that opener as its own rather than a control of the dialog going
  // away (which would leave focus nowhere once the queue is done).
  const [between, setBetween] = useState(false);
  const seq = useRef(0);
  // Every request not resolved yet, and those whose dialog just closed.
  const unresolved = useRef(new Set<ConfirmRequest>());
  const closed = useRef<ConfirmRequest[]>([]);
  const mounted = useRef(true);

  const settle = (req: ConfirmRequest) => {
    unresolved.current.delete(req);
    req.resolve(req.ok);
  };

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        const req = {
          id: ++seq.current,
          options,
          ok: false,
          running: false,
          resolve,
        };
        unresolved.current.add(req);
        setQueue((q) => [...q, req]);
      }),
    [],
  );

  // Settle once the dialog is gone and focus is back (passive cleanups run
  // first), so the caller's follow-up (focus, navigation) has the last word.
  useEffect(() => {
    for (const req of closed.current.splice(0)) settle(req);
  }, [queue]);

  useEffect(() => {
    if (between) setBetween(false);
  }, [between]);

  useEffect(() => {
    const pending = unresolved.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Unmounted: open and waiting requests are cancelled; a running
      // action settles its request when it finishes.
      closed.current = [];
      for (const req of [...pending]) if (!req.running) settle(req);
    };
  }, []);

  const run = async (req: ConfirmRequest) => {
    req.running = true;
    try {
      await req.options.action?.();
      req.ok = true;
    } finally {
      req.running = false;
      if (!mounted.current) settle(req);
    }
  };

  const close = (req: ConfirmRequest) => {
    closed.current.push(req);
    setQueue((q) => q.filter((r) => r !== req));
    setBetween(true);
  };

  const current = between ? undefined : queue[0];
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current ? (
        <ConfirmDialog
          key={current.id}
          open
          title={current.options.title}
          confirmLabel={current.options.confirmLabel}
          cancelLabel={current.options.cancelLabel}
          tone={current.options.tone}
          onConfirm={() => run(current)}
          onClose={() => close(current)}
        >
          {current.options.body}
        </ConfirmDialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}
