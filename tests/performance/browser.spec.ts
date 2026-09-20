import { writeFile } from "node:fs/promises";
import { test, expect } from "../e2e/fixtures";
import { openSedesWorkspace, capture, openSettingsPage } from "../e2e/helpers";
import { benchmarkTurns, benchmarkMessageCharacters, benchmarkStreamItems } from "./codex-browser-fixture";

// Recording every DOM mutation substantially perturbs long-history timings.
// Keep normal E2E recording enabled; only this opt-in benchmark disables it.
test.use({ trace: "off", video: "off", screenshot: "off" });

for (const profile of [
  { name: "desktop", width: 1440, height: 1000, cpu: 1 },
  { name: "mobile", width: 390, height: 844, cpu: 4 },
]) {
  test(`browser performance ${profile.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await openSedesWorkspace(page);
    const row = page.getByTestId("desktop-sidebar").getByTestId("thread-row-link").filter({ hasText: "Imported Codex history" }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const threadPath = new URL(page.url()).pathname;
    const threadId = threadPath.split("/").at(-1)!;
    await expect(page.getByTestId("composer")).toBeVisible();
    const initialComposer = page.getByTestId("composer").getByRole("textbox").first();
    if (await initialComposer.inputValue()) {
      const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/draft") && response.ok());
      await initialComposer.fill("");
      await saved;
    }
    await page.goto("/");
    expect((await page.request.post(`/__e2e/browser-benchmark/${threadId}/seed`)).ok()).toBe(true);
    await page.setViewportSize({ width: profile.width, height: profile.height });
    const cdp = await page.context().newCDPSession(page);
    const profiling = process.env.SEDES_BROWSER_PROFILE === "1";
    const threadStreams = new Set<string>();
    const eventCounts: Record<string, { count: number; jsonUtf8Bytes: number }> = {};
    const historyResponses: Promise<number>[] = [];
    if (profiling) {
      await cdp.send("Profiler.enable");
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
        if (new URL(request.url).pathname === `/api/threads/${threadId}/events`) threadStreams.add(requestId);
      });
      cdp.on("Network.eventSourceMessageReceived", ({ requestId, data, eventName }) => {
        if (!threadStreams.has(requestId)) return;
        const envelope = JSON.parse(data) as { event?: { type?: string } };
        const type = envelope.event?.type ?? eventName;
        const record = eventCounts[type] ??= { count: 0, jsonUtf8Bytes: 0 };
        record.count += 1;
        record.jsonUtf8Bytes += Buffer.byteLength(data);
      });
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === `/api/threads/${threadId}/history` && response.ok()) {
          historyResponses.push(response.body().then((body) => body.byteLength));
        }
      });
    }
    const startProfile = async () => { if (profiling) await cdp.send("Profiler.start"); };
    const stopProfile = async (phase: string) => {
      if (!profiling) return;
      const { profile: cpuProfile } = await cdp.send("Profiler.stop");
      const filename = testInfo.outputPath(`${phase}.cpuprofile`);
      await writeFile(filename, JSON.stringify(cpuProfile));
      await testInfo.attach(`${phase}.cpuprofile`, { path: filename, contentType: "application/json" });
    };
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    await page.addInitScript(() => {
      localStorage.setItem("sedes-diagnostics-streaming", "true");
      localStorage.setItem("sedes-diagnostics-thread-load", "true");
      const entries: number[] = [];
      const frames: number[] = [];
      let previous = performance.now();
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { if (entries.length < 5000) entries.push(entry.duration); }
      }).observe({ type: "longtask", buffered: true });
      const sample = (now: number) => { if (frames.length < 20_000) frames.push(now - previous); previous = now; requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      Object.assign(window, { __browserBenchmark: { entries, frames } });
    });
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const samples: unknown[] = [];
    const summarize = async (phase: string, started: number, before: Record<string, number>) => {
      const after = await metrics();
      const browser = await page.evaluate(() => {
        const data = (window as unknown as { __browserBenchmark: { entries: number[]; frames: number[] } }).__browserBenchmark;
        const tasks = data.entries.splice(0);
        const frames = data.frames.splice(0).sort((a, b) => a - b);
        return { longTaskCount: tasks.length, longTaskMilliseconds: tasks.reduce((a, b) => a + b, 0), maxLongTaskMilliseconds: Math.max(0, ...tasks), frameGapP95Milliseconds: frames[Math.floor(frames.length * 0.95)] ?? 0, domNodes: document.querySelectorAll("*").length, renderedTurns: document.querySelectorAll('[data-turn-id]').length };
      });
      samples.push({ phase, wallMilliseconds: performance.now() - started, ...browser,
        taskMilliseconds: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
        layoutMilliseconds: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
        scriptMilliseconds: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
        heapBytes: after.JSHeapUsedSize });
    };
    let before = await metrics();
    let started = performance.now();
    await page.goto(threadPath);
    await page.waitForFunction(() => document.querySelector(".conversation-turn:last-child h2")?.textContent === "Checkpoint 99", undefined, { timeout: 60_000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await summarize("load", started, before);
    await startProfile();
    before = await metrics(); started = performance.now();
    await page.getByRole("button", { name: "Load all", exact: true }).click();
    await expect(page.locator(".conversation-turn[data-turn-id]")).toHaveCount(100, { timeout: 60_000 });
    await page.locator('[data-turn-id]').last().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await summarize("loadAllHistory", started, before);
    await stopProfile("load-all-history");
    await startProfile();
    before = await metrics(); started = performance.now();
    expect((await page.request.post(`/__e2e/browser-benchmark/${threadId}/stream`)).ok()).toBe(true);
    // Poll only the newest turn. Full-document text locators traverse the old
    // history on every retry and can dominate the work being measured.
    await page.waitForFunction(() => document.querySelector(".conversation-turn:last-child")?.textContent?.includes("Browser benchmark stream complete."), undefined, { timeout: 60_000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await summarize("stream", started, before);
    await stopProfile("stream");
    before = await metrics(); started = performance.now();
    const composer = page.getByTestId("composer").getByRole("textbox").first();
    await composer.fill("Measure interaction after a long conversation");
    await expect(composer).toHaveValue("Measure interaction after a long conversation");
    await page.mouse.move(profile.width / 2, profile.height / 2);
    await page.mouse.wheel(0, -2000);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await summarize("interaction", started, before);
    // Screenshots deliberately run outside all measured phases.
    await capture(page, testInfo, `benchmark-${profile.name}-stream-observation.png`);
    await page.locator(".conversation-turn").nth(99).locator("h2").scrollIntoViewIfNeeded();
    await capture(page, testInfo, `benchmark-${profile.name}-history.png`);
    const report = JSON.stringify({ format: "sedes-browser-performance-v1", profile, instrumentation: { trace: false, video: false, cpuProfile: profiling }, workload: { turns: benchmarkTurns, messageCharacters: benchmarkMessageCharacters, streamItems: benchmarkStreamItems }, samples }, null, 2);
    await writeFile(testInfo.outputPath("browser-performance.json"), report);
    await testInfo.attach("browser-performance.json", { path: testInfo.outputPath("browser-performance.json"), contentType: "application/json" });
    console.log(JSON.stringify({ profile: profile.name, samples }));
    // Export the existing gated, content-free diagnostics through its normal UI.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { Object.assign(window, { __benchmarkDiagnostics: text }); } });
    });
    await openSettingsPage(page, "diagnostics");
    await page.getByRole("button", { name: /^Copy log/ }).click();
    const diagnostics = await page.evaluate(() => (window as unknown as { __benchmarkDiagnostics: string }).__benchmarkDiagnostics);
    await writeFile(testInfo.outputPath("client-diagnostics.json"), diagnostics);
    await testInfo.attach("client-diagnostics.json", { path: testInfo.outputPath("client-diagnostics.json"), contentType: "application/json" });
    if (profiling) {
      const filename = testInfo.outputPath("browser-network-summary.json");
      await writeFile(filename, JSON.stringify({ eventCounts, historyPageJsonBytes: await Promise.all(historyResponses) }, null, 2));
      await testInfo.attach("browser-network-summary.json", { path: filename, contentType: "application/json" });
    }
    await cdp.detach();
  });
}
