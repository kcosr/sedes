import "./automations-view.css";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";

/** Every automation across threads (`/automations`). */
export function AutomationsView(_props: {
  store: ApplicationClientStore;
}): React.JSX.Element {
  return (
    <section className="automations-view" aria-labelledby="automations-title">
      <div className="automations-page">
        <h1 id="automations-title">Automations</h1>
      </div>
    </section>
  );
}
