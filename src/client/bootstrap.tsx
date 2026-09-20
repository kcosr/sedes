import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { installAppearance } from "./app/appearance";
import { installEnvironmentColors } from "./app/environment-palette";
import { installSidebarCollapsed } from "./app/sidebar-collapsed";
import { installSidebarWidth } from "./app/sidebar-width";
import { installTasksPanelWidth } from "./app/tasks-panel-width";
import type { WorkspacePanelTenantRegistry } from "./workspace-panels/registry";
import "./styles.css";

export function startApplication(
  panelTenants: WorkspacePanelTenantRegistry,
): void {
  const removeAppearanceListener = installAppearance();
  const removeEnvironmentColorListener = installEnvironmentColors();
  installSidebarWidth();
  installTasksPanelWidth();
  installSidebarCollapsed();
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      removeAppearanceListener();
      removeEnvironmentColorListener();
    });
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("Missing application root");

  createRoot(root).render(
    <React.StrictMode>
      <App panelTenants={panelTenants} />
    </React.StrictMode>,
  );
}
