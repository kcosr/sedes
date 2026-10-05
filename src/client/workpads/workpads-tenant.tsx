import { lazy, Suspense } from "react";
import { NotepadText } from "lucide-react";
import type { WorkspacePanelTenant } from "../workspace-panels/registry.js";

const LazyWorkpadsPanel = lazy(async () => {
  const module = await import("./WorkpadsPanel.js");
  return { default: module.WorkpadsPanel };
});

export const workpadsTenant: WorkspacePanelTenant = {
  id: "workpads",
  title: "Workpads",
  icon: NotepadText,
  scope: "global",
  // A reading column, 320–480px and about two fifths of the stage, so Chat
  // keeps its header and composer at 1024px.
  size: { minWidth: 320, minHeight: 240, preferredWidth: 480, preferredHeight: 560, preferredShare: 0.4 },
  preferredPlacement: { edge: "right" },
  availability: () => ({ available: true }),
  render: (context) => <Suspense fallback={<div>Loading workpads…</div>}><LazyWorkpadsPanel context={context} /></Suspense>,
};
