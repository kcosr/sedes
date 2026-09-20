import { lazy, Suspense } from "react";
import { Files } from "lucide-react";
import type { WorkspacePanelTenant } from "../workspace-panels/registry.js";

const LazyWorkspaceFilesPanel = lazy(async () => {
  const module = await import("./WorkspaceFilesPanel.js");
  return { default: module.WorkspaceFilesPanel };
});

export const workspaceFilesTenant: WorkspacePanelTenant = {
  id: "workspace-files",
  title: "Files",
  icon: Files,
  scope: "workspace",
  size: {
    minWidth: 320,
    minHeight: 240,
    preferredWidth: 520,
    preferredHeight: 560,
  },
  preferredPlacement: { edge: "right" },
  attachments: { sourceKinds: ["workspace_file", "workspace_diff"] },
  availability: ({ workspace }) =>
    workspace
      ? { available: true }
      : { available: false, reason: "Open a workspace to browse files." },
  render: (context) => (
    <Suspense
      fallback={
        <div className="workspace-files-message">Loading file browser…</div>
      }
    >
      <LazyWorkspaceFilesPanel context={context} />
    </Suspense>
  ),
};
