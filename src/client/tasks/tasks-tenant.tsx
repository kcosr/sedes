import { ListChecks } from "lucide-react";
import { TasksDockSlot } from "../components/tasks/tasks-host.js";
import type { WorkspacePanelTenant } from "../workspace-panels/registry.js";

/**
 * Tasks in its region, beside Chat by default. Whether it is loaded, and
 * where, is shared across threads like Workpads, and its content follows
 * the current chat. The content renders the panel header itself (with the
 * layout's Maximize, Move to and close controls), so the layout adds no
 * `PanelChrome` of its own. The retained body lives in the Tasks host,
 * which also presents it as a phone sheet.
 */
export const tasksTenant: WorkspacePanelTenant = {
  id: "tasks",
  title: "Tasks",
  icon: ListChecks,
  scope: "thread",
  header: "tenant",
  // About a third of the stage, 300–380px, so Chat keeps its header and
  // composer at 1024px.
  size: {
    minWidth: 300,
    minHeight: 240,
    preferredWidth: 380,
    preferredHeight: 480,
    preferredShare: 0.35,
  },
  availability: () => ({ available: true }),
  render: (context) => <TasksDockSlot panelHost={context.host} />,
};
