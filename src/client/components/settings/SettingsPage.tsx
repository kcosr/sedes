import "./settings.css";
import { ChevronLeft } from "lucide-react";
import { navigateUp } from "../../app/router.js";
import { isPlainClick } from "./SettingsNav.js";

export interface SettingsBack {
  readonly label: string;
  /** Rendered as a link that goes up to this path when set; `onNavigate`
   * can still intercept the click by preventing its default. */
  readonly href?: string;
  readonly onNavigate?: (event: React.MouseEvent<HTMLElement>) => void;
}

export type SettingsPageProps = Omit<React.ComponentProps<"div">, "title"> & {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Header actions, right-aligned; put the primary action last. */
  readonly actions?: React.ReactNode;
  /** A "‹ Settings" style link above the title. */
  readonly back?: SettingsBack;
  /** `wide` is for inventory pages (lists beside details). */
  readonly width?: "default" | "wide";
  /** The page heading takes focus after navigation (it has tabIndex -1). */
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
};

/** One settings page: back link, title, description and actions over the page body. */
export function SettingsPage({
  title,
  description,
  actions,
  back,
  width = "default",
  headingRef,
  className,
  children,
  ...props
}: SettingsPageProps): React.JSX.Element {
  return (
    <div data-slot="settings-page" data-width={width} className={className} {...props}>
      <header data-slot="settings-page-header">
        {back ? <SettingsBackLink {...back} /> : null}
        <div data-slot="settings-page-heading">
          <div data-slot="settings-page-titles">
            <h1 ref={headingRef} tabIndex={-1} data-slot="settings-page-title">{title}</h1>
            {description ? <p data-slot="settings-page-description">{description}</p> : null}
          </div>
          {actions ? <div data-slot="settings-page-actions">{actions}</div> : null}
        </div>
      </header>
      <div data-slot="settings-page-body">{children}</div>
    </div>
  );
}

export type SettingsBackLinkProps = SettingsBack &
  Omit<React.HTMLAttributes<HTMLElement>, "children" | "onClick">;

/**
 * "‹ Settings" style link above a page or pane title. A link goes up
 * through `navigateUp`, so it and browser or Android Back walk the same
 * history; without `href` it is a button for `onNavigate`.
 */
export function SettingsBackLink({ label, href, onNavigate, ...props }: SettingsBackLinkProps): React.JSX.Element {
  const content = <><ChevronLeft aria-hidden="true" />{label}</>;
  return href === undefined ? (
    <button type="button" data-slot="settings-page-back" {...props} onClick={onNavigate}>
      {content}
    </button>
  ) : (
    <a data-slot="settings-page-back" href={href} {...props} onClick={(event) => {
      onNavigate?.(event);
      if (event.defaultPrevented || !isPlainClick(event)) return;
      event.preventDefault();
      navigateUp(href);
    }}>{content}</a>
  );
}
