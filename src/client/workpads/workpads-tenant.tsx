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
  size: { minWidth: 320, minHeight: 240, preferredWidth: 620, preferredHeight: 560 },
  preferredPlacement: { edge: "right" },
  availability: () => ({ available: true }),
  render: (context) => <Suspense fallback={<div>Loading workpads…</div>}><LazyWorkpadsPanel context={context} /></Suspense>,
};
