import { automationsPath, navigate } from "../../app/router.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { isPlainClick } from "../settings/SettingsNav.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { Button } from "@client/components/ui/button";
import { EmptyState } from "@client/components/ui/empty-state";
import { Skeleton } from "@client/components/ui/skeleton";
import { useAutomationUp, type AutomationUp } from "./automation-navigation.js";

/**
 * The frame the automation page and editor share with the Automations list,
 * kept while they load or fail too. Escape and Android Back without history
 * take `up`, as the "‹" link in the header (AutomationBackLink) does.
 */
export function AutomationFrame({
  label,
  up,
  children,
}: {
  readonly label?: string;
  readonly up: AutomationUp;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  useAutomationUp(up.go);
  return (
    <section className="automations-view" aria-label={label}>
      <div className="automations-page automation-page">{children}</div>
    </section>
  );
}

/** The page's or editor's one "‹" link, named for where it leads. */
export function AutomationBackLink({ up }: { readonly up: AutomationUp }): React.JSX.Element {
  return (
    <SettingsBackLink
      href={up.href}
      label={up.label}
      onNavigate={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        up.go();
      }}
    />
  );
}

/** The page or editor while its automation or thread loads. */
export function AutomationAnchorLoading({
  back,
}: {
  readonly back: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="automation-page-loading" role="status" aria-label="Loading automation">
      {back}
      <Skeleton className="automation-page-skeleton-title" />
      <Skeleton className="automation-page-skeleton-card" />
    </div>
  );
}

function AllAutomations(): React.JSX.Element {
  return (
    <Button type="button" variant="outline" onClick={() => navigate(automationsPath())}>
      All automations
    </Button>
  );
}

/** The page or editor when its thread could not be loaded, with the reason. */
export function AutomationAnchorUnavailable({
  back,
  message,
  onRetry,
}: {
  readonly back: React.ReactNode;
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <>
      <SettingsDetailHeader back={back} headingLevel={1} title="Automation" />
      <EmptyState
        title="Couldn't open this thread"
        description={message}
        action={
          <>
            <AllAutomations />
            <Button type="button" onClick={onRetry}>
              Try again
            </Button>
          </>
        }
      />
    </>
  );
}

/** The page or editor when its automation could not be loaded: removed, or the reason. */
export function AutomationUnavailable({
  back,
  message,
  missing,
  onRetry,
}: {
  readonly back: React.ReactNode;
  readonly message: string;
  readonly missing: boolean;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <>
      <SettingsDetailHeader back={back} headingLevel={1} title="Automation" />
      {missing ? (
        <EmptyState
          title="This automation was removed"
          description="It was deleted, or it was a one-time reminder whose result was dismissed. Its thread and messages stay."
          action={<AllAutomations />}
        />
      ) : (
        <EmptyState
          title="Couldn't open this automation"
          description={message}
          action={
            <>
              <AllAutomations />
              <Button type="button" onClick={onRetry}>
                Try again
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
