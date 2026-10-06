import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";

/** Create or edit a thread's automation (`/automations/:threadId/edit`). */
export function AutomationEditor(_props: {
  store: ApplicationClientStore;
  threadId: string;
}): React.JSX.Element {
  return (
    <section className="automations-view" aria-labelledby="automation-editor-title">
      <h1 id="automation-editor-title">Edit automation</h1>
    </section>
  );
}
