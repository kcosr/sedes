import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@client/components/ui/button";
import { EmptyState } from "@client/components/ui/empty-state";
import { ErrorBoundary } from "@client/components/ui/error-boundary";
import { useComposerDraftStaging } from "../context-excerpts/coordinator.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import type { PanelChromeStatus } from "./PanelChrome.js";
import type {
  WorkspacePanelContext,
  WorkspacePanelHost,
  WorkspacePanelPresentation,
  WorkspacePanelTenant,
} from "./registry.js";

/** A Files, Workpads or Tasks tenant's content, with its host. */
export function TenantContent({
  tenant,
  threadId,
  workspaceId,
  workspaceLabel,
  applicationStore,
  threadRegistry,
  intent,
  visible,
  presentation,
  chromeActionsTarget,
  onStatus,
  onConsumeIntent,
  onClose,
}: {
  readonly tenant: WorkspacePanelTenant;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly applicationStore: ApplicationClientStore;
  readonly threadRegistry: ThreadStoreRegistry;
  readonly intent?: unknown;
  readonly visible: boolean;
  readonly presentation: WorkspacePanelPresentation;
  readonly chromeActionsTarget: HTMLElement;
  readonly onStatus: (status: PanelChromeStatus) => void;
  readonly onConsumeIntent: (sequence: number) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const contextExcerpts = useComposerDraftStaging();
  const [status, setStatus] = useState<PanelChromeStatus>({});
  const closeRef = useRef(onClose);
  const statusRef = useRef(onStatus);
  const consumeIntentRef = useRef(onConsumeIntent);
  closeRef.current = onClose;
  statusRef.current = onStatus;
  consumeIntentRef.current = onConsumeIntent;
  const host = useMemo<WorkspacePanelHost>(
    () => ({
      close: () => closeRef.current(),
      consumeIntent: (sequence) => consumeIntentRef.current(sequence),
      setBusy: (busy) => setStatus((current) => ({ ...current, busy })),
      setDirty: (dirty) => setStatus((current) => ({ ...current, dirty })),
      setSubtitle: (subtitle) =>
        setStatus((current) => ({ ...current, subtitle })),
    }),
    [],
  );
  useEffect(() => statusRef.current(status), [status]);
  useEffect(() => () => statusRef.current({}), []);
  const context: WorkspacePanelContext = {
    applicationStore,
    threadRegistry,
    host,
    visible,
    presentation,
    chromeActionsTarget,
    ...(contextExcerpts ? { contextExcerpts } : {}),
    // Workpads follows route context for its list while keeping its
    // device-wide placement and lifetime across thread navigation.
    ...(tenant.scope !== "global" || tenant.id === "workpads" ? { threadId } : {}),
    ...((tenant.scope !== "global" || tenant.id === "workpads") && workspaceId ? { workspaceId } : {}),
    ...((tenant.scope !== "global" || tenant.id === "workpads") && workspaceLabel ? { workspaceLabel } : {}),
    ...(intent !== undefined ? { intent } : {}),
  };
  return (
    <div
      className="workspace-panel-tenant"
      data-tenant-id={tenant.id}
      data-visible={visible ? "true" : "false"}
      tabIndex={-1}
    >
      {/* A failing panel shows its own recovery; Chat and the other panels keep working. */}
      <ErrorBoundary
        // What the crashed content reported (busy, unsaved) went with it.
        onError={() => setStatus({})}
        fallback={({ reset }) => (
          <EmptyState
            className="m-3"
            title={`${tenant.title} couldn’t be displayed.`}
            description="Something went wrong in this panel. The rest of Sedes still works."
            action={
              <>
                <Button variant="outline" size="sm" onClick={reset}>
                  Reload panel
                </Button>
                <Button variant="ghost" size="sm" onClick={() => closeRef.current()}>
                  Close panel
                </Button>
              </>
            }
          />
        )}
      >
        <TenantBody tenant={tenant} context={context} />
      </ErrorBoundary>
    </div>
  );
}

/** Renders inside the boundary, so a tenant whose render throws is contained too. */
function TenantBody({ tenant, context }: {
  readonly tenant: WorkspacePanelTenant;
  readonly context: WorkspacePanelContext;
}): React.ReactNode {
  return tenant.render(context);
}

/** A tenant's static ⋯ items, for the panel header's menu. */
export function renderTenantMenu(
  tenant: WorkspacePanelTenant,
  input: {
    readonly threadId: string;
    readonly workspaceId?: string;
    readonly applicationStore: ApplicationClientStore;
    readonly threadRegistry: ThreadStoreRegistry;
    readonly visible: boolean;
    readonly intent?: unknown;
    readonly chromeActionsTarget: HTMLElement;
  },
): React.ReactNode {
  if (!tenant.renderMenuItems) return undefined;
  const noopHost: WorkspacePanelHost = {
    close: () => undefined,
    consumeIntent: () => undefined,
    setBusy: () => undefined,
    setDirty: () => undefined,
    setSubtitle: () => undefined,
  };
  return tenant.renderMenuItems({
    applicationStore: input.applicationStore,
    threadRegistry: input.threadRegistry,
    host: noopHost,
    visible: input.visible,
    presentation: "dock",
    chromeActionsTarget: input.chromeActionsTarget,
    ...(tenant.scope === "thread" ? { threadId: input.threadId } : {}),
    ...(tenant.scope !== "global" && input.workspaceId
      ? { workspaceId: input.workspaceId }
      : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
  });
}
