import { automationsPath, navigate } from "../../app/router.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { Button } from "@client/components/ui/button";
import { EmptyState } from "@client/components/ui/empty-state";
import { Skeleton } from "@client/components/ui/skeleton";

/** The page or editor while its thread loads. */
export function AutomationAnchorLoading({
  back,
}: {
  readonly back?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="automation-page-loading" role="status" aria-label="Loading automation">
      {back}
      <Skeleton className="automation-page-skeleton-title" />
      <Skeleton className="automation-page-skeleton-card" />
    </div>
  );
}

/** The page or editor when its thread could not be loaded, with the reason. */
export function AutomationAnchorUnavailable({
  back,
  message,
  onRetry,
}: {
  readonly back?: React.ReactNode;
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
            <Button type="button" variant="outline" onClick={() => navigate(automationsPath())}>
              All automations
            </Button>
            <Button type="button" onClick={onRetry}>
              Try again
            </Button>
          </>
        }
      />
    </>
  );
}
