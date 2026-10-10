import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.js";

/** A panel kind as the workbench names it. */
export type PanelTitle = "Chat" | "Files" | "Workpads" | "Tasks" | "Terminals";
export type RegionTitle = "Middle" | "Left" | "Right" | "Top" | "Bottom";

const PANEL_KINDS: Readonly<Record<PanelTitle, string>> = {
  Chat: "chat",
  Files: "files",
  Workpads: "workpads",
  Tasks: "tasks",
  Terminals: "terminals",
};

/** A panel on the stage: its region's section, wherever it is placed. */
export function stagePanel(page: Page, title: PanelTitle): Locator {
  return page.locator(`.workspace-panel-stage [data-panel-kind="${PANEL_KINDS[title]}"]`);
}

/** A loaded panel's quick button in the workbench bar. */
export function quickButton(page: Page, title: PanelTitle): Locator {
  return page
    .getByTestId("workspace-workbench-bar")
    .getByTestId(`${PANEL_KINDS[title]}-panel-toggle`);
}

/** Opens ▾, the launcher for every panel: a menu, or a sheet on phones. */
export async function openPanelsMenu(page: Page): Promise<Locator> {
  await page
    .getByTestId("workspace-workbench-bar")
    .getByRole("button", { name: "Panels", exact: true })
    .click();
  const menu = page
    .getByRole("menu", { name: "Panels", exact: true })
    .or(page.getByRole("dialog", { name: "Panels", exact: true }))
    // A sheet is a dialog around its menu: the dialog.
    .first();
  await expect(menu).toBeVisible();
  return menu;
}

/** A panel's row in the open ▾ menu, named "Title[, state]". */
export function panelRow(menu: Locator, title: PanelTitle): Locator {
  return menu.locator(`[data-panel-row="${PANEL_KINDS[title]}"]`);
}

/** Opens a panel in its place from ▾. */
export async function openPanel(page: Page, title: PanelTitle): Promise<void> {
  const menu = await openPanelsMenu(page);
  await panelRow(menu, title).click();
  await expect(menu).toBeHidden();
}

/** Opens a panel in `region` from its ▾ row's place menu; that becomes its place. */
export async function openPanelIn(
  page: Page,
  title: PanelTitle,
  region: RegionTitle,
): Promise<void> {
  const menu = await openPanelsMenu(page);
  await menu
    .getByRole("menuitem", { name: `Choose where to open ${title}`, exact: true })
    .click();
  await page
    .getByRole("group", { name: `Open ${title} in`, exact: true })
    .getByRole("menuitemradio", { name: region, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/** Moves a panel with its header's ⋯ → Move to. */
export async function movePanel(
  page: Page,
  title: PanelTitle,
  region: RegionTitle,
): Promise<void> {
  await stagePanel(page, title)
    .getByRole("button", { name: `${title} panel actions`, exact: true })
    .click();
  await page
    .getByRole("group", { name: "Move to", exact: true })
    .getByRole("menuitemradio", { name: region, exact: true })
    .click();
  await expect(stagePanel(page, title)).toHaveAttribute("data-region", region.toLowerCase());
}

/** The workbench's live announcement. */
export function panelAnnouncement(page: Page): Locator {
  return page.locator('[data-testid="workspace-panel-layout"] > p[role="status"]');
}
