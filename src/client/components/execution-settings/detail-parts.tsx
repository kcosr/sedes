import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Check, Copy } from "lucide-react";
import { navigate } from "../../app/router.js";
import { isPlainClick } from "../settings/SettingsNav.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { cn } from "../../lib/utils.js";
import type { GeneralError } from "./validation.js";

/**
 * Follows an in-app link through the router, so guards run and history
 * stays in one place. Modified clicks keep the browser's own behavior.
 */
export function followLink(event: React.MouseEvent<HTMLElement>, path: string): void {
  if (event.defaultPrevented || !isPlainClick(event)) return;
  event.preventDefault();
  navigate(path);
}

/**
 * "‹ Environments" above a detail or editor: the kit's back link, which goes
 * up through history. `stackOnly` hides it while the list is beside the
 * detail, where the list itself is the way back.
 */
export function BackLink({ href, label, stackOnly = false }: { readonly href: string; readonly label: string; readonly stackOnly?: boolean }): React.JSX.Element {
  return <SettingsBackLink label={label} href={href} className="execution-back" data-stack-only={stackOnly || undefined} />;
}

export function DetailHeader({ back, icon, title, headingRef, tags, status, description, actions }: {
  readonly back?: ReactNode;
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly tags?: ReactNode;
  readonly status?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}): React.JSX.Element {
  return <header className="execution-detail-header">
    {back}
    <div className="execution-detail-heading">
      <div className="execution-detail-titles">
        <div className="execution-detail-title-row">
          {icon ? <span className="execution-detail-icon" aria-hidden="true">{icon}</span> : null}
          <h2 ref={headingRef} tabIndex={-1} className="execution-detail-title" data-execution-heading="">{title}</h2>
          {tags || status ? <span className="execution-detail-meta">{tags}{status}</span> : null}
        </div>
        {description ? <p className="execution-detail-description">{description}</p> : null}
      </div>
      {actions ? <div className="execution-detail-actions" role="group" aria-label="Actions">{actions}</div> : null}
    </div>
  </header>;
}

let lastFocused: Element | null = null;
if (typeof document !== "undefined") document.addEventListener("focusin", (event) => { lastFocused = event.target instanceof Element ? event.target : null; }, true);

/** The control a person used to open something: a menu item stands for its menu's trigger. */
export function openerOf(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const labelledBy = element.closest("[role=menu]")?.getAttribute("aria-labelledby");
  return labelledBy ? document.getElementById(labelledBy) : element;
}

/**
 * Returns focus to what opened a controlled dialog, through the dialog's
 * `returnFocusRef`: the control focused when it opened (a menu item stands
 * for its menu's trigger). Assign `returnFocusRef.current` to send focus
 * elsewhere, such as the heading of a location the dialog's action opened.
 */
export function useFocusReturn() {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return {
    returnFocusRef,
    onOpenAutoFocus: () => { returnFocusRef.current = openerOf(document.activeElement) ?? openerOf(lastFocused); },
  };
}

/** An identifier or path that people copy but rarely read: monospaced, with a copy button. */
export function CopyableValue({ value, label }: { readonly value: string; readonly label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <span className="execution-copyable">
    <code>{value}</code>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined)}>
      {copied ? <Check /> : <Copy />}
    </Button>
  </span>;
}

export interface EditorSection {
  readonly id: string;
  readonly label: string;
}

/**
 * Section anchors for a long editor. They scroll the settings column rather
 * than change the URL, and mark the section in view.
 */
export function SectionAnchors({ sections }: { readonly sections: readonly EditorSection[] }): React.JSX.Element {
  const nav = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState(sections[0]?.id);
  const [stuck, setStuck] = useState(false);
  const key = sections.map((section) => section.id).join(" ");
  useEffect(() => {
    // Stuck under the scroller's top padding, the bar masks that strip so
    // content does not show through above it.
    const scroller = nav.current?.closest(".settings-content");
    if (typeof IntersectionObserver !== "function" || !scroller || !sentinel.current) return;
    const inset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    const observer = new IntersectionObserver(([entry]) => setStuck(Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) + inset)),
      { root: scroller, rootMargin: `-${inset}px 0px 0px 0px` });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const scroller = nav.current?.closest(".settings-content");
    if (typeof IntersectionObserver !== "function" || !scroller) return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
      const first = sections.find((section) => visible.get(section.id));
      if (first) setCurrent(first.id);
    }, { root: scroller, rootMargin: "-48px 0px -55% 0px" });
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return <><span ref={sentinel} aria-hidden="true" className="execution-anchors-sentinel" /><nav ref={nav} aria-label="Editor sections" className="execution-anchors" data-stuck={stuck || undefined}>
    {sections.map((section) => <button key={section.id} type="button" aria-current={current === section.id ? "true" : undefined}
      onClick={() => {
        const target = document.getElementById(section.id);
        target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
        target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
        setCurrent(section.id);
      }}>{section.label}</button>)}
  </nav></>;
}

/** Errors that belong to no single field, described in words. */
export function GeneralErrors({ errors, title = "Fix these before saving" }: { readonly errors: readonly GeneralError[]; readonly title?: string }): React.JSX.Element | null {
  if (!errors.length) return null;
  if (errors.length === 1 && !errors[0]!.location) return <Callout tone="danger" role="alert">{errors[0]!.message}</Callout>;
  return <Callout tone="danger" role="alert" title={title}>
    <ul className="execution-error-list">{errors.map((error, index) => <li key={index}>
      {error.location ? <><span className="execution-error-location">{error.location}</span>: </> : null}{error.message}
    </li>)}</ul>
  </Callout>;
}

/**
 * The frame of an editor in the detail pane: a way back, the title, section
 * anchors, form-level errors, the sections and a sticky save bar.
 */
export function EditorFrame({ label, back, title, headingRef, description, sections, errors, onSubmit, saveBar, children, className }: {
  /** Names the editor region. */
  readonly label: string;
  readonly back?: ReactNode;
  readonly title: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly description?: ReactNode;
  readonly sections?: readonly EditorSection[];
  readonly errors?: ReactNode;
  readonly onSubmit: () => void;
  readonly saveBar: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return <section aria-label={label} className={cn("execution-editor", className)}>
    <header className="execution-detail-header">
      {back}
      <div className="execution-detail-titles">
        <h2 ref={headingRef} tabIndex={-1} className="execution-detail-title" data-execution-heading="">{title}</h2>
        {description ? <p className="execution-detail-description">{description}</p> : null}
      </div>
    </header>
    {errors}
    <div className="execution-editor-body">
      {sections && sections.length > 1 ? <SectionAnchors sections={sections} /> : null}
      <form className="execution-editor-form" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {children}
        {saveBar}
      </form>
    </div>
  </section>;
}
