import "./settings.css";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

/**
 * What an inventory page shows beside its list: nothing, an entity, or an
 * editor. Set on the SettingsPage (`selection`), it decides the stacked
 * layout: the list, or the selection with its "‹" link back.
 */
export type SettingsSelection = "none" | "detail" | "editor";

export type SettingsSplitProps = Omit<React.ComponentProps<"div">, "children"> & {
  /** Names the list pane region. */
  readonly listLabel: string;
  readonly list: ReactNode;
  /** The detail pane: the selection, or an empty state. */
  readonly children: ReactNode;
  /** The selection takes the full width in the split layout (a long editor). */
  readonly wide?: boolean;
  /**
   * Nothing to list yet: the detail pane, holding the empty state and its
   * call to action, takes the list's place at every width.
   */
  readonly empty?: boolean;
};

/**
 * An inventory page's list beside its selection. The panes split when the
 * settings column (the shell's `settings-content` container) is at least
 * 960px wide and stack below that: the list, or the selection. Content
 * above the panes that belongs with the list (filters, defaults) carries
 * `data-stack="list"` and gives way to a selection in the stack too.
 */
export function SettingsSplit({ listLabel, list, children, wide = false, empty = false, ...props }: SettingsSplitProps): React.JSX.Element {
  return (
    <div data-slot="settings-split" data-wide={wide || undefined} data-empty={empty || undefined} {...props}>
      <section data-slot="settings-split-list" aria-label={listLabel}>{list}</section>
      <div data-slot="settings-split-detail">{children}</div>
    </div>
  );
}

/**
 * The header of a detail or editor pane, on the settings page header's
 * anatomy: in the stacked layout it stands in for the page header. The
 * heading takes focus when its location opens (`data-detail-heading`).
 */
export function SettingsDetailHeader({ back, icon, title, headingRef, tags, status, description, actions }: {
  readonly back?: ReactNode;
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly tags?: ReactNode;
  readonly status?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}): React.JSX.Element {
  return <header data-slot="settings-page-header">
    {back}
    <div data-slot="settings-page-heading">
      <div data-slot="settings-page-titles">
        <div data-slot="settings-detail-title-row">
          {icon ? <span data-slot="settings-detail-icon" aria-hidden="true">{icon}</span> : null}
          <h2 ref={headingRef} tabIndex={-1} data-slot="settings-page-title" data-detail-heading="">{title}</h2>
          {tags || status ? <span data-slot="settings-detail-meta">{tags}{status}</span> : null}
        </div>
        {description ? <p data-slot="settings-page-description">{description}</p> : null}
      </div>
      {actions ? <div data-slot="settings-page-actions" role="group" aria-label="Actions">{actions}</div> : null}
    </div>
  </header>;
}

export interface SettingsEditorSection {
  readonly id: string;
  readonly label: string;
}

/**
 * Section anchors for a long editor. They scroll the settings column rather
 * than change the URL, and mark the section in view.
 */
export function SettingsSectionAnchors({ sections }: { readonly sections: readonly SettingsEditorSection[] }): React.JSX.Element {
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
  return <><span ref={sentinel} aria-hidden="true" data-slot="settings-anchors-sentinel" /><nav ref={nav} aria-label="Editor sections" data-slot="settings-anchors" data-stuck={stuck || undefined}>
    {sections.map((section) => <button key={section.id} type="button" aria-current={current === section.id ? "true" : undefined}
      onClick={() => {
        const target = document.getElementById(section.id);
        target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
        target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
        setCurrent(section.id);
      }}>{section.label}</button>)}
  </nav></>;
}

/**
 * The frame of an editor in the detail pane: a way back, the title, section
 * anchors, form-level errors, the sections and a sticky save bar.
 */
export function SettingsEditor({ label, back, title, headingRef, description, sections, errors, onSubmit, saveBar, children, className }: {
  /** Names the editor region. */
  readonly label: string;
  readonly back?: ReactNode;
  readonly title: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly description?: ReactNode;
  readonly sections?: readonly SettingsEditorSection[];
  readonly errors?: ReactNode;
  readonly onSubmit: () => void;
  readonly saveBar: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return <section aria-label={label} data-slot="settings-editor" className={className}>
    <SettingsDetailHeader back={back} title={title} headingRef={headingRef} description={description} />
    {errors}
    <div data-slot="settings-editor-body">
      {sections && sections.length > 1 ? <SettingsSectionAnchors sections={sections} /> : null}
      <form data-slot="settings-editor-form" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        {children}
        {saveBar}
      </form>
    </div>
  </section>;
}
