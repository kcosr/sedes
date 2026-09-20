import type { ComponentType, ReactNode } from "react";
import type {
  ContextExcerptSource,
  NormalizedThreadSnapshot,
  NormalizedWorkspaceSummary,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { workpadsTenant } from "../workpads/workpads-tenant.js";
import { workspaceFilesTenant } from "../workspace-files/workspace-files-tenant.js";
import type { ComposerDraftStagingTarget } from "../context-excerpts/coordinator.js";

export type WorkspacePanelScope = "thread" | "workspace" | "global";
export type WorkspacePanelPresentation = "dock" | "sheet";
export type WorkspacePanelEdge = "left" | "right" | "top" | "bottom";

export interface WorkspacePanelAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface ContextualAttachmentDeclaration {
  readonly sourceKinds: readonly ContextExcerptSource["kind"][];
}

export interface WorkspacePanelHost {
  close(): void;
  consumeIntent(sequence: number): void;
  setBusy(busy: boolean): void;
  setDirty(dirty: boolean): void;
  setSubtitle(text?: string): void;
}

export interface WorkspacePanelContext {
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly applicationStore: ApplicationClientStore;
  readonly threadRegistry: ThreadStoreRegistry;
  readonly host: WorkspacePanelHost;
  readonly presentation: WorkspacePanelPresentation;
  /** Stable host for controls owned by the panel but rendered in its chrome. */
  readonly chromeActionsTarget: HTMLElement;
  /** Route-bound access to the active thread's composer draft, when mounted. */
  readonly contextExcerpts?: ComposerDraftStagingTarget;
  /**
   * Whether the singleton surface is currently displayed. Collapsed surfaces
   * remain mounted and must suppress layout- or focus-affecting work while
   * this is false.
   */
  readonly visible: boolean;
  readonly intent?: unknown;
}

export interface WorkspacePanelTenant {
  readonly id: string;
  readonly title: string;
  readonly icon: ComponentType<{ readonly size?: number }>;
  readonly scope: WorkspacePanelScope;
  readonly size: {
    readonly minWidth: number;
    readonly minHeight: number;
    readonly preferredWidth: number;
    readonly preferredHeight: number;
  };
  readonly preferredPlacement: {
    readonly edge: "right" | "bottom";
  };
  availability(input: {
    readonly snapshot?: NormalizedThreadSnapshot;
    readonly workspace?: NormalizedWorkspaceSummary;
  }): WorkspacePanelAvailability;
  render(context: WorkspacePanelContext): ReactNode;
  renderMenuItems?(context: WorkspacePanelContext): ReactNode;
  readonly attachments?: ContextualAttachmentDeclaration;
}

export class WorkspacePanelTenantRegistry {
  readonly #tenants: ReadonlyMap<string, WorkspacePanelTenant>;
  readonly entries: readonly WorkspacePanelTenant[];

  constructor(tenants: readonly WorkspacePanelTenant[]) {
    const byId = new Map<string, WorkspacePanelTenant>();
    const entries: WorkspacePanelTenant[] = [];
    for (const tenant of tenants) {
      if (byId.has(tenant.id)) {
        throw new Error(`duplicate_workspace_panel:${tenant.id}`);
      }
      const frozen = freezeTenant(tenant);
      byId.set(frozen.id, frozen);
      entries.push(frozen);
    }
    this.#tenants = byId;
    this.entries = Object.freeze(entries);
    Object.freeze(this);
  }

  tenant(id: string): WorkspacePanelTenant | undefined {
    return this.#tenants.get(id);
  }

  has(id: string): boolean {
    return this.#tenants.has(id);
  }
}

function freezeTenant(tenant: WorkspacePanelTenant): WorkspacePanelTenant {
  return Object.freeze({
    ...tenant,
    size: Object.freeze({ ...tenant.size }),
    preferredPlacement: Object.freeze({ ...tenant.preferredPlacement }),
    ...(tenant.attachments
      ? {
          attachments: Object.freeze({
            sourceKinds: Object.freeze([...tenant.attachments.sourceKinds]),
          }),
        }
      : {}),
  });
}

export const workspacePanelTenants = new WorkspacePanelTenantRegistry([
  workspaceFilesTenant,
  workpadsTenant,
]);
