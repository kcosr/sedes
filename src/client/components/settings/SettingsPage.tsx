import "./settings.css";
import { ChevronLeft } from "lucide-react";

export interface SettingsBack {
  readonly label: string;
  /** Rendered as a link when set; `onNavigate` can still intercept the click. */
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

function SettingsBackLink({ label, href, onNavigate }: SettingsBack): React.JSX.Element {
  const content = <><ChevronLeft aria-hidden="true" />{label}</>;
  return href === undefined ? (
    <button type="button" data-slot="settings-page-back" onClick={onNavigate}>
      {content}
    </button>
  ) : (
    <a data-slot="settings-page-back" href={href} onClick={onNavigate}>{content}</a>
  );
}
