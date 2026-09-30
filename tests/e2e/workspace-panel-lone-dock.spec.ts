import { test, expect } from "./fixtures";
import { createDraftThread, openSedesWorkspace } from "./helpers";

test("Files panel instance dock menu responds to mouse clicks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await expect(page.getByTestId("workspace-panel-layout")).toBeVisible();

  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
  const files = page.getByRole("region", { name: "Workspace files" });
  await expect(files).toBeVisible();
  await files.evaluate((node) => {
    (
      window as typeof window & { __singletonFiles?: Element }
    ).__singletonFiles = node;
  });

  await page.getByRole("button", { name: "Files panel actions" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Right", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Bottom", exact: true }).click();
  await expect(
    page.locator(
      '[data-testid="workspace-panel-split"][data-orientation="column"]',
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Files panel actions" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Bottom", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Right", exact: true }).click();
  await expect(
    page.locator(
      '[data-testid="workspace-panel-split"][data-orientation="row"]',
    ),
  ).toBeVisible();
  expect(
    await files.evaluate(
      (node) =>
        (window as typeof window & { __singletonFiles?: Element })
          .__singletonFiles === node,
    ),
  ).toBe(true);
});
