import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "@playwright/test";
import { WORKSPACE_FILE_PRIMARY_ROOT_ID } from "../../src/shared/workspace-file-limits.js";
import { SEDES_DOWNLOAD_REVISION_HEADER } from "../../src/shared/downloads.js";
import { test, expect } from "./fixtures.js";
import { capture, createDraftThread, fillAndPersistDraft, openWorkspaceDirectory, sendCurrentDraft } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture } from "./voice-controls-fixture.js";

for (const transport of ["native", "fetch"] as const) {
  test(`${transport} SSE decodes gzip snapshots, live updates and cursor replay without closing`, async ({ page }, testInfo) => {
    // Only the platform bridge is simulated: both transports use the actual
    // application server, HTTP encoder, normalized events and browser decoder.
    if (transport === "fetch") await installVoiceFixture(page);
    const workspace = path.join(loadE2ERunContext().workspacesDirectory, `compression-${transport}`);
    const fileText = "A compressible workspace document: 界 🌍.\n".repeat(160);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "document.txt"), fileText);
    const settled = new Set<Request>();
    page.on("requestfinished", request => settled.add(request));
    page.on("requestfailed", request => settled.add(request));
    const applicationStarted = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/application/events");
    const workspaceOpened = page.waitForResponse(response =>
      response.request().method() === "POST" && response.url().endsWith("/api/workspaces/open"));
    await openWorkspaceDirectory(page, workspace);
    const workspaceId = (await (await workspaceOpened).json()).id as string;
    const application = await applicationStarted;
    expect(application.status()).toBe(200);
    expect(application.headers()["content-encoding"]).toBe("gzip");
    expect(application.request().resourceType()).toBe(transport === "native" ? "eventsource" : "fetch");
    expect(settled.has(application.request())).toBe(false);

    const initialStarted = page.waitForResponse(response => /\/api\/threads\/[^/]+\/events$/.test(new URL(response.url()).pathname));
    const firstPath = await createDraftThread(page, `Compressed ${transport} thread`);
    const initial = await initialStarted;
    const eventsPath = `/api${firstPath}/events`;
    expect(initial.headers()["content-encoding"]).toBe("gzip");
    expect(initial.request().resourceType()).toBe(transport === "native" ? "eventsource" : "fetch");
    await expect(page.getByText("This thread is ready")).toBeVisible();
    expect(settled.has(initial.request())).toBe(false);

    // Browser fetch decodes JSON too; credential-bearing and exact-byte
    // download endpoints retain identity and their existing length contract.
    const data = await page.evaluate(async ({ workspaceId, rootId, revisionHeader }) => {
      const session = await fetch("/api/application/session");
      const sessionValue = await session.json();
      const snapshot = await fetch("/api/application/snapshot");
      const snapshotValue = await snapshot.json();
      const parameters = new URLSearchParams({ rootId, path: "document.txt" });
      const content = await fetch(`/api/workspaces/${workspaceId}/files/content?${parameters}`);
      const document = await content.json();
      parameters.set("expectedRevision", document.revision);
      const url = `/api/workspaces/${workspaceId}/files/download?${parameters}`;
      const head = await fetch(url, { method: "HEAD" });
      const download = await fetch(url);
      const bytes = new Uint8Array(await download.arrayBuffer());
      return {
        sessionStatus: session.status, sessionEncoding: session.headers.get("content-encoding"), csrfToken: sessionValue.csrfToken,
        snapshotStatus: snapshot.status, snapshotEncoding: snapshot.headers.get("content-encoding"), snapshotThreadIds: snapshotValue.threads.map((thread: { id: string }) => thread.id),
        contentStatus: content.status, contentEncoding: content.headers.get("content-encoding"), content: document.content,
        headStatus: head.status, headEncoding: head.headers.get("content-encoding"), headLength: head.headers.get("content-length"),
        downloadStatus: download.status, downloadEncoding: download.headers.get("content-encoding"), downloadLength: download.headers.get("content-length"),
        headRevision: head.headers.get(revisionHeader), downloadRevision: download.headers.get(revisionHeader), revision: document.revision,
        downloadedText: new TextDecoder().decode(bytes), byteLength: bytes.byteLength,
      };
    }, { workspaceId, rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID, revisionHeader: SEDES_DOWNLOAD_REVISION_HEADER });
    expect(data.sessionStatus).toBe(200);
    expect(data.sessionEncoding).toBeNull();
    expect(data.csrfToken).toEqual(expect.any(String));
    expect(data.snapshotStatus).toBe(200);
    expect(data.snapshotEncoding).toBe("gzip");
    expect(data.snapshotThreadIds).toContain(firstPath.split("/").at(-1));
    expect(data.contentStatus).toBe(200);
    expect(data.contentEncoding).toBe("gzip");
    expect(data.content).toBe(fileText);
    expect(data.headStatus).toBe(200);
    expect(data.downloadStatus).toBe(200);
    expect(data.headEncoding).toBeNull();
    expect(data.downloadEncoding).toBeNull();
    expect(data.headLength).toBe(String(Buffer.byteLength(fileText)));
    expect(data.downloadLength).toBe(data.headLength);
    expect(data.byteLength).toBe(Buffer.byteLength(fileText));
    expect(data.downloadedText).toBe(fileText);
    expect(data.headRevision).toBe(data.revision);
    expect(data.downloadRevision).toBe(data.revision);

    await fillAndPersistDraft(page, "Accumulate a retained background response");
    await sendCurrentDraft(page);
    const assistant = page.locator('[data-item-kind="assistant_message"]').filter({ hasText: "Background response ready." });
    await expect(assistant).toHaveAttribute("data-item-status", "streaming");
    expect(settled.has(initial.request())).toBe(false);
    await capture(page, testInfo, `compression-${transport}-streaming.png`);

    // Switching away closes the first stream. The retained normalized cursor
    // must resume over a new gzip member and catch up the background burst.
    await createDraftThread(page, `Other ${transport} thread`);
    await expect.poll(() => settled.has(initial.request())).toBe(true);
    expect((await page.request.post("/__e2e/pi/background-burst/release")).status()).toBe(204);
    const replayStarted = page.waitForResponse(response => new URL(response.url()).pathname === eventsPath);
    await page.getByTestId("desktop-sidebar").getByTestId("thread-row-link").filter({ hasText: `Compressed ${transport} thread` }).click();
    const replay = await replayStarted;
    expect(new URL(replay.url()).searchParams.get("replayCursor")).toMatch(/\S+/);
    expect(replay.headers()["content-encoding"]).toBe("gzip");
    await expect(assistant).toContainText("Background update 640:");
    await expect(assistant).toHaveAttribute("data-item-status", "streaming");
    expect(settled.has(replay.request())).toBe(false);
    await capture(page, testInfo, `compression-${transport}-replay.png`);
    expect((await page.request.post("/__e2e/pi/background-burst/finish")).status()).toBe(204);
    await expect(assistant).toHaveAttribute("data-item-status", "completed");
    await expect(assistant).toContainText("Background response complete: 界 🌍.");
    expect(settled.has(replay.request())).toBe(false);
    expect(settled.has(application.request())).toBe(false);
  });
}
