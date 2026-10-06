import "./automations-view.css";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";

/** One automation, read-only, with its runs (`/automations/:threadId`). */
export function AutomationPage(_props: {
  store: ApplicationClientStore;
  threadId: string;
}): React.JSX.Element {
  return (
    <section className="automations-view" aria-labelledby="automation-title">
      <div className="automations-page">
        <h1 id="automation-title">Automation</h1>
      </div>
    </section>
  );
}
