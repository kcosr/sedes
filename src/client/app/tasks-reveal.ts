import { setTasksPanelOpen } from "./tasks-panel-store.js";

/**
 * INTEGRATION STUB (Tasks UI track X). The spec puts `revealTask(taskId)` in
 * `app/tasks-panel-store.ts` (track H): it opens Tasks, switches to a view
 * that contains the task, and expands it (track B handles the reveal in the
 * panel content). Until those tracks land, this stub only opens Tasks. At
 * integration, delete this file and import `revealTask` from
 * `./tasks-panel-store.js` instead.
 */
export function revealTask(_taskId: string): void {
  setTasksPanelOpen(true);
}
