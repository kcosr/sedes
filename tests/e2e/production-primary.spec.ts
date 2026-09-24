import { test, expect } from "./fixtures";
import { capture, createDraftThread, expectNoPageOverflow, openSedesWorkspace, openSettingsPage } from "./helpers";

test("fresh production workbench starts with the Chat panel instance", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);

  await expect(page.getByTestId("thread-view")).toBeVisible();
  await expect(page.getByTestId("workspace-panel-layout")).toBeVisible();
  await expect(page.getByTestId("workspace-panel-split")).toHaveCount(0);
  // The workbench always offers its panel menu; Chat alone is open here.
  await expect(page.getByRole("button", { name: "Panels" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Workspace files" }),
  ).toHaveCount(0);
  await capture(page, testInfo, "singleton-production-chat-default.png");
});

test("mobile Accounts opens as a viewport-anchored bottom sheet", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date(2099, 7, 20, 12) });
  await page.route("**/api/application/session", async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...session, providerPulseEnabled: true },
    });
  });
  await page.route("**/api/provider-pulse/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        generatedAt: "2026-08-16T19:00:00.000Z",
        health: "healthy",
        accounts: [
          usageAccount(
            "grok-alt",
            "Grok · Alt",
            "grok",
            100,
            new Date(2099, 7, 22, 23).toISOString(),
          ),
          usageAccount(
            "codex-work",
            "Codex · Work",
            "codex",
            7,
            new Date(2099, 7, 20, 23).toISOString(),
          ),
          usageAccount(
            "claude-main",
            "Claude · Main",
            "claude",
            40,
            new Date(2099, 7, 21, 23).toISOString(),
          ),
        ],
        usageBaseline: { health: "healthy", metrics: [] },
      }),
    });
  });
  await openSedesWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Thread navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "More" }).click();
  const usageMenuItem = page.getByRole("menuitem", { name: "Accounts" });
  await expect(usageMenuItem).toBeVisible({ timeout: 5_000 });
  await usageMenuItem.click();

  const usage = page.getByRole("dialog", { name: "Accounts" });
  await expect(usage).toBeVisible();
  const resetDays = usage.locator(".sidebar-usage-reset-day");
  await expect(resetDays).toHaveText(["today", "tomorrow", "Sat"]);
  const resetDayLefts = await resetDays.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().left),
  );
  expect(Math.max(...resetDayLefts) - Math.min(...resetDayLefts)).toBeLessThan(
    0.5,
  );
  const remainingColumns = usage.locator(
    ".sidebar-usage-summary > .sidebar-usage-remaining",
  );
  await expect(remainingColumns).toHaveText(["7%", "40%", "100%"]);
  const remainingLefts = await remainingColumns.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().left),
  );
  expect(
    Math.max(...remainingLefts) - Math.min(...remainingLefts),
  ).toBeLessThan(0.5);
  const resetToRemainingGaps = await usage
    .locator(".sidebar-usage-summary")
    .evaluateAll((summaries) =>
      summaries.map((summary) => {
        const reset = summary.querySelector(".sidebar-usage-reset-day");
        const remaining = summary.querySelector(".sidebar-usage-remaining");
        if (
          !(reset instanceof HTMLElement) ||
          !(remaining instanceof HTMLElement)
        ) {
          return Number.NaN;
        }
        return (
          remaining.getBoundingClientRect().left -
          reset.getBoundingClientRect().right
        );
      }),
    );
  expect(resetToRemainingGaps).toEqual(
    expect.arrayContaining([expect.any(Number)]),
  );
  expect(Math.min(...resetToRemainingGaps)).toBeGreaterThanOrEqual(23.5);
  const box = await usage.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.width - 390)).toBeLessThanOrEqual(1);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(box!.y + box!.height - 844)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await capture(page, testInfo, "provider-pulse-usage-mobile-sheet.png");
});

function usageAccount(
  id: string,
  label: string,
  brand: "codex" | "claude" | "grok",
  remainingPercent: number,
  resetsAt: string,
): Record<string, unknown> {
  return {
    id,
    label,
    provider: brand,
    brand,
    usage: {
      health: "healthy",
      inFlight: false,
      lastSuccessAt: "2026-08-16T19:00:00.000Z",
      snapshot: {
        observedAt: "2026-08-16T19:00:00.000Z",
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            durationMinutes: 10_080,
            remainingPercent,
            resetsAt,
          },
        ],
        balances: [],
      },
    },
  };
}

test("browser pairing hides private UI and unpairing returns to the connection gate", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const token = "BCDF-GHJK";
  const client = {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Test browser",
    kind: "management",
    createdAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2027-09-13T00:00:00.000Z",
  };
  let authenticated = false;
  let unpaired = false;
  await page.route("**/api/auth/status", (route) => route.fulfill({
    json: { required: true, authenticated, ...(authenticated ? { client } : {}) },
  }));
  await page.route("**/api/auth/pair", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ token, clientName: "Sedes browser", kind: "browser" });
    expect(route.request().url()).not.toContain(token);
    authenticated = true;
    await route.fulfill({ json: { client } });
  });
  await page.route("**/api/auth/clients", (route) => route.fulfill({ json: { clients: [client] } }));
  await page.route("**/api/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    authenticated = false;
    unpaired = true;
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/#pair=${token}`);
  await expect(page.getByRole("heading", { name: "Pair with this server" })).toBeVisible();
  await expect(page).not.toHaveURL(/#pair=/);
  await expect(page.getByTestId("desktop-sidebar")).toHaveCount(0);
  await expect(page.getByLabel("Pairing URL or code")).toHaveAttribute("type", "password");
  const pairingCard = page.getByRole("region", { name: "Pair with this server" });
  const fieldSpacing = async () => pairingCard.locator(".authentication-pairing-field").evaluateAll((fields) =>
    fields.map((field) => {
      const label = field.querySelector("label")!.getBoundingClientRect();
      const input = field.querySelector("input")!.getBoundingClientRect();
      return input.top - label.bottom;
    }),
  );
  for (const gap of await fieldSpacing()) expect(gap).toBeGreaterThanOrEqual(8);
  const pairButton = page.getByRole("button", { name: "Pair connection", exact: true });
  const retryButton = page.getByRole("button", { name: "Retry connection", exact: true });
  const desktopPair = (await pairButton.boundingBox())!;
  const desktopRetry = (await retryButton.boundingBox())!;
  expect(desktopRetry.x - desktopPair.x - desktopPair.width).toBeGreaterThanOrEqual(12);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "browser-pairing-gate.png");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const gap of await fieldSpacing()) expect(gap).toBeGreaterThanOrEqual(8);
  // Shared buttons animate their responsive minimum height. Wait for the
  // actual mobile hit target rather than sampling the resize transition.
  for (const control of await pairingCard.locator("input, button").all()) {
    await expect.poll(async () => (await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const mobilePair = (await pairButton.boundingBox())!;
  const mobileRetry = (await retryButton.boundingBox())!;
  expect(mobileRetry.y - mobilePair.y - mobilePair.height).toBeGreaterThanOrEqual(12);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "browser-pairing-gate-mobile.png");
  // A short viewport (including an on-screen keyboard) must scroll the form
  // without trapping its heading above the scroll origin or hiding actions.
  await page.setViewportSize({ width: 390, height: 360 });
  await retryButton.scrollIntoViewIfNeeded();
  await expect(retryButton).toBeInViewport();
  await page.getByRole("heading", { name: "Pair with this server" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "Pair with this server" })).toBeInViewport();
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairButton.click();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();

  await openSettingsPage(page, "paired_clients");
  const settings = page.getByTestId("settings-view");
  await expect(settings.getByText("Test browser (this connection)")).toBeVisible();
  await capture(page, testInfo, "browser-paired-clients.png");
  await settings.getByRole("button", { name: "Unpair", exact: true }).click();
  expect(unpaired).toBe(false);
  await settings.getByRole("button", { name: "Confirm unpair", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pair with this server" })).toBeVisible();
  await expect(page.getByTestId("desktop-sidebar")).toHaveCount(0);
  expect(unpaired).toBe(true);
});
