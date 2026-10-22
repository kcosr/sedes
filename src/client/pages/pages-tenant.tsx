import { lazy, Suspense } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { WorkspacePanelTenant } from "../workspace-panels/registry.js";

const LazyPagesPanel = lazy(async () => {
  const module = await import("./PagesPanel.js");
  return { default: module.PagesPanel };
});

export const pagesTenant: WorkspacePanelTenant = {
  id: "pages",
  title: "Pages",
  icon: PanelsTopLeft,
  scope: "thread",
  size: { minWidth: 360, minHeight: 240, preferredWidth: 800, preferredHeight: 560, preferredShare: 0.5 },
  availability: () => ({ available: true }),
  render: (context) => <Suspense fallback={<div role="status">Loading pages…</div>}><LazyPagesPanel context={context} /></Suspense>,
};
