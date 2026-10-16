// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationControlsContext } from "../app/navigation-controls.js";
import { automationsPath, navigate } from "../app/router.js";
import {
  AUTOMATION_ID,
  THREAD_ID,
  automationStore,
  definition,
  installAutomationDom,
} from "./automation/automation-test-fixture.js";

vi.mock("./SidebarNavTrigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SidebarNavTrigger.js")>()),
  SidebarNavTrigger: () => <button type="button">Hide sidebar</button>,
}));

import { Workbench } from "./Workbench.js";

beforeEach(installAutomationDom);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigate("/", { replace: true });
});

function renderPage(sidebarCollapsed?: boolean) {
  navigate(automationsPath(THREAD_ID), { replace: true });
  navigate(`/automations/${AUTOMATION_ID}`);
  const fixture = automationStore([{ automation: definition() }]);
  const workbench = (
    <Workbench
      route={{ name: "automation", automationId: AUTOMATION_ID, edit: false }}
      applicationStore={fixture.store}
      threadRegistry={fixture.threadRegistry as never}
      panelLayoutStore={{} as never}
      panelTenants={{} as never}
    />
  );
  return render(
    sidebarCollapsed === undefined ? workbench : (
      <NavigationControlsContext.Provider value={{ sidebarCollapsed } as never}>
        {workbench}
      </NavigationControlsContext.Provider>
    ),
  );
}

describe("Workbench automation pages", () => {
  it("puts the page's one way up in the pane bar while the bar shows", async () => {
    const { container } = renderPage(true);
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    const bar = container.querySelector(".pane-nav-header")!;
    const back = bar.querySelector('.settings-view-back-slot > [data-slot="settings-page-back"]');
    expect(back).toHaveTextContent("Automations");
    expect(container.querySelectorAll('[data-slot="settings-page-back"]')).toHaveLength(1);
  });

  it("keeps the link above the title beside the sidebar", async () => {
    const { container } = renderPage(false);
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(container.querySelector(".settings-view-back-slot")).toBeEmptyDOMElement();
    const back = container.querySelector('.automation-page [data-slot="settings-page-back"]');
    expect(back).toHaveTextContent("Automations");
  });
});
