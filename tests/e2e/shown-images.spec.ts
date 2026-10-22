import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { imageShowResultSchema, type ImageShowRequest } from "../../src/shared/protocol/image-show.js";
import { pageRevisionPageSchema } from "../../src/shared/protocol/pages.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { test, expect } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory, overlaySettled, sendCurrentDraft } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";

async function showImage(page: Page, threadId: string, input: ImageShowRequest) {
  const response = await page.request.post(`/__e2e/threads/${threadId}/images`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return imageShowResultSchema.parse(await response.json()).image;
}

async function chartImage(page: Page, color: string, label: string): Promise<Buffer> {
  const encoded = await page.evaluate(({ color, label }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f2f5ff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#152447";
    context.font = "bold 28px sans-serif";
    context.fillText(label, 32, 52);
    context.font = "18px sans-serif";
    for (let index = 0; index < 4; index++) {
      const height = 70 + index * 40;
      context.fillStyle = color;
      context.fillRect(48 + index * 144, 292 - height, 92, height);
      context.fillStyle = "#152447";
      context.fillText(`Run ${index + 1}`, 62 + index * 144, 324);
    }
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, { color, label });
  return Buffer.from(encoded, "base64");
}

test("shown images stay inline and retained after source deletion, completion, and reload", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "shown-images");
  const imagePath = path.join(workspace, "results.png");
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstBytes = await chartImage(page, "#356bc7", "Results before change");
  await writeFile(imagePath, firstBytes);
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page, "Images shown in conversation");
  const threadId = threadPath.split("/").at(-1)!;
  expect((await page.request.post("/__e2e/pi/turn-response/arm")).status()).toBe(204);
  await fillAndPersistDraft(page, "Show the results chart while this turn stays active.");
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  try {
    const first = await showImage(page, threadId, { path: imagePath, title: "Results chart" });
    expect(first.sha256).toBe(createHash("sha256").update(firstBytes).digest("hex"));
    const firstImage = page.getByRole("img", { name: "Results chart", exact: true });
    await expect(firstImage).toBeVisible();
    await expect(firstImage).toHaveAttribute("src", /^blob:/);
    await expect(page.getByTestId("viewed-image-group")).toHaveCount(0);
    await expect.poll(() => firstImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
    await capture(page, testInfo, "shown-image-streaming-desktop.png");

    const secondBytes = await chartImage(page, "#397d5e", "Results after change");
    await writeFile(imagePath, secondBytes);
    const second = await showImage(page, threadId, { path: imagePath });
    expect(second.sha256).toBe(createHash("sha256").update(secondBytes).digest("hex"));
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.artifactId).not.toBe(first.artifactId);
    await expect(page.getByRole("img", { name: "results.png", exact: true })).toBeVisible();
    await expect(page.locator('[data-item-kind="image"]')).toHaveCount(2);
    await rm(imagePath);

    // Summary projection must retain explicit images, and never leak the
    // source path or add these ephemeral-display requests to the Pages catalog.
    for (const activityDetail of ["full", "summary"]) {
      const response = await page.request.get(`/api${threadPath}?activityDetail=${activityDetail}`);
      expect(response.ok(), await response.text()).toBe(true);
      const snapshot = normalizedThreadSnapshotSchema.parse(await response.json());
      const images = Object.values(snapshot.itemsById).filter(item => item.kind === "image");
      expect(images).toHaveLength(2);
      expect(images.map(item => item.origin)).toEqual([{ kind: "shown" }, { kind: "shown" }]);
      expect(images.map(item => item.image)).toEqual([first, second]);
      expect(JSON.stringify(snapshot)).not.toContain(imagePath);
    }
    const pagesResponse = await page.request.get(`/api${threadPath}/pages`);
    expect(pagesResponse.ok()).toBe(true);
    expect(pageRevisionPageSchema.parse(await pagesResponse.json()).items).toEqual([]);
    expect((await page.request.post("/__e2e/pi/turn-response/release")).status()).toBe(204);
    // Releasing the gate starts the real conformance response: thirteen
    // scripted 800ms stages, followed by authoritative completion delivery.
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.goto("/");
    await expect.poll(async () => (await page.request.post(`/__e2e/threads/${threadId}/close-idle-runtime`)).status()).toBe(204);
    await page.goto(threadPath);
    await page.reload();

    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await firstImage.scrollIntoViewIfNeeded();
      await expect(firstImage).toBeVisible();
      await expectNoPageOverflow(page);
      await capture(page, testInfo, `shown-image-retained-${viewport.width}.png`);
      const expand = page.getByRole("button", { name: "Expand image: Results chart", exact: true });
      await expand.click();
      const viewer = page.getByRole("dialog", { name: "Image preview: Results chart", exact: true });
      await expect(viewer).toBeVisible();
      await overlaySettled(viewer);
      const zoom = viewer.getByRole("button", { name: /^Zoom percentage:/ });
      const originalZoom = await zoom.textContent();
      await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(zoom).not.toHaveText(originalZoom!);
      await capture(page, testInfo, `shown-image-viewer-${viewport.width}.png`);
      await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(viewer).toHaveCount(0);
      await expect(expand).toBeFocused();
    }
    for (const image of [first, second]) {
      const response = await page.request.get(`/api${threadPath}/output-artifacts/${image.artifactId}/content`);
      expect(response.ok()).toBe(true);
      expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(image.sha256);
    }
  } finally {
    await page.request.post("/__e2e/pi/turn-response/release");
  }
});
