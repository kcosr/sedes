import {
  AlertCircle,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { NormalizedInstallationAdvisory } from "../../shared/index.js";
import { Button } from "./ui/button.js";
import { BackendBrandIcon } from "./brand-icons.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";

const TONE_ICONS: Readonly<
  Record<NormalizedInstallationAdvisory["tone"], LucideIcon>
> = {
  info: Info,
  warning: TriangleAlert,
  error: AlertCircle,
};

function AdvisoryTrigger({
  count,
  fallbackFocusRef,
}: {
  readonly count: number;
  readonly fallbackFocusRef: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    return () => {
      if (trigger !== document.activeElement) return;
      fallbackFocusRef.current?.focus();
    };
  }, [fallbackFocusRef]);

  return (
    <DialogTrigger asChild>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="sidebar-footer-advisories"
        aria-label={`Warnings, ${count} active`}
        title="Warnings"
      >
        <TriangleAlert aria-hidden="true" />
        <span className="sidebar-footer-advisory-count" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      </Button>
    </DialogTrigger>
  );
}

export function AdvisoryCenter({
  advisories,
  fallbackFocusRef,
}: {
  readonly advisories: readonly NormalizedInstallationAdvisory[];
  readonly fallbackFocusRef: RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const restoreFallbackFocus = useRef(false);

  useEffect(() => {
    if (advisories.length > 0 || !open) return;
    restoreFallbackFocus.current = true;
    setOpen(false);
  }, [advisories.length, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && advisories.length === 0) return;
        setOpen(nextOpen);
      }}
    >
      {advisories.length > 0 ? (
        <AdvisoryTrigger
          count={advisories.length}
          fallbackFocusRef={fallbackFocusRef}
        />
      ) : null}
      <DialogContent
        className="advisory-center-sheet"
        overlayClassName="advisory-center-sheet-overlay"
        placement="side"
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          if (!restoreFallbackFocus.current) return;
          restoreFallbackFocus.current = false;
          event.preventDefault();
          fallbackFocusRef.current?.focus();
        }}
      >
        <header className="advisory-center-header">
          <DialogTitle>Warnings</DialogTitle>
          <DialogDescription>
            Active application and backend warnings.
          </DialogDescription>
        </header>
        <div className="advisory-center-list">
          {advisories.map((advisory) => {
            const ToneIcon = TONE_ICONS[advisory.tone];
            return (
              <article
                className="advisory-center-item"
                data-tone={advisory.tone}
                key={advisory.id}
              >
                <ToneIcon
                  className="advisory-center-item-icon"
                  aria-hidden="true"
                />
                <div className="advisory-center-item-content">
                  {advisory.source.kind === "backend_instance" ? (
                    <div className="advisory-center-source">
                      <BackendBrandIcon
                        brand={advisory.source.backend}
                        size={13}
                      />
                      <span>{advisory.source.label.text}</span>
                      {advisory.source.environment ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{advisory.source.environment.label.text}</span>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div className="advisory-center-source">
                      <span>Sedes</span>
                    </div>
                  )}
                  <h3>{advisory.title.text}</h3>
                  <p>{advisory.message.text}</p>
                </div>
              </article>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
