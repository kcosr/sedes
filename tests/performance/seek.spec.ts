import { writeFile } from "node:fs/promises";
import { test, expect } from "../e2e/fixtures";
import {
  openSedesWorkspace,
  capture,
  createDraftThread,
  fillAndPersistDraft,
  selectRadixOption,
  sendCurrentDraft,
} from "../e2e/helpers";

test.use({ trace: "off", video: "off", screenshot: "off" });

for (const profile of [
  { name: "desktop", width: 1440, height: 1000, cpu: 1 },
  { name: "mobile", width: 390, height: 844, cpu: 4 },
  { name: "mobile resize", width: 390, height: 500, cpu: 1, resizedHeight: 844 },
]) {
  test(`seek performance ${profile.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      localStorage.setItem("sedes-seek-on-submit", "true");
      localStorage.setItem("sedes-chat-atmosphere", "false");
      for (const category of ["seek", "streaming", "thread-load", "composer-input"]) {
        localStorage.setItem(`sedes-diagnostics-${category}`, "false");
      }
    });
    await openSedesWorkspace(page);
    await page.getByTestId("desktop-sidebar").getByTestId("thread-row-link")
      .filter({ hasText: "Imported Codex history" }).first().click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const threadPath = new URL(page.url()).pathname;
    const threadId = threadPath.split("/").at(-1)!;
    await expect(page.getByTestId("composer")).toBeVisible();
    await selectRadixOption(page, page.getByTestId("composer").getByRole("combobox", { name: "Model" }), "GPT-5.6 Codex");
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
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    if (profiling) await cdp.send("Profiler.enable");
    await page.goto(threadPath);
    await page.waitForFunction(() => document.querySelector(".conversation-turn:last-child h2")?.textContent === "Checkpoint 99", undefined, { timeout: 60_000 });
    console.log(`Seek fixture ready: ${profile.name}`);
    const reports: unknown[] = [];
    for (const expanded of [false, true]) {
      if ("resizedHeight" in profile) {
        await page.setViewportSize({ width: profile.width, height: profile.height });
      }
      if (expanded) {
        await page.getByRole("button", { name: "Load all", exact: true }).click();
        await expect(page.locator(".conversation-turn[data-turn-id]")).toHaveCount(101, { timeout: 60_000 });
      }
      const composer = page.getByTestId("composer").getByRole("textbox").first();
      const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/draft") && response.ok());
      await composer.fill(`Measure seek with ${expanded ? "expanded" : "initial"} history`);
      await saved;
      const send = page.getByTestId("composer").getByRole("button", { name: "Send message" });
      await expect(send).toBeEnabled();
      await page.locator(".message-viewport").evaluate((viewport) => { viewport.scrollTop = viewport.scrollHeight; });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.evaluate((profiling) => {
        const viewport = document.querySelector<HTMLElement>(".message-viewport")!;
        const started = performance.now();
        const frames: { at: number; top: number }[] = [];
        const tasks: { at: number; duration: number }[] = [];
        const writes: { at: number; top: number }[] = [];
        const geometry: unknown[] = [];
        const requests: { at: number; top?: number; behavior?: ScrollBehavior }[] = [];
        const scrollTo = viewport.scrollTo.bind(viewport);
        Object.defineProperty(viewport, "scrollTo", {
          configurable: true,
          value: (options: ScrollToOptions) => {
            requests.push({ at: performance.now() - started, top: options.top, behavior: options.behavior });
            scrollTo(options);
          },
        });
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        if (profiling) Object.defineProperty(viewport, "scrollTop", {
          configurable: true,
          get: () => descriptor.get!.call(viewport),
          set: (top: number) => {
            writes.push({ at: performance.now() - started, top });
            descriptor.set!.call(viewport, top);
          },
        });
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) tasks.push({ at: entry.startTime - started, duration: entry.duration });
        });
        observer.observe({ type: "longtask" });
        let frame = 0;
        const sample = (now: number) => {
          frames.push({ at: now - started, top: viewport.scrollTop });
          if (profiling) {
            const users = viewport.querySelectorAll<HTMLElement>('[data-item-kind="user_message"]');
            const target = users[users.length - 1];
            geometry.push({ at: now - started, targetId: target?.dataset.itemId, provisional: target?.dataset.clientProvisional,
              targetTop: target?.getBoundingClientRect().top, targetOffset: target?.offsetTop,
              height: viewport.clientHeight, scrollHeight: viewport.scrollHeight,
              windowTop: window.scrollY,
              ancestors: [viewport.parentElement, viewport.parentElement?.parentElement].map((element) => element?.scrollTop),
            });
          }
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        Object.assign(window, { __seekMeasurement: {
          get nativeStarted() { return requests.some((request) => request.behavior === "smooth"); },
          finish: () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            if (profiling) delete (viewport as Partial<HTMLElement>).scrollTop;
            delete (viewport as Partial<HTMLElement>).scrollTo;
            return { frames, tasks, writes, geometry, requests, turns: document.querySelectorAll(".conversation-turn[data-turn-id]").length };
          },
        } });
      }, profiling);
      const timeline: unknown[] = [];
      const traceData = ({ value }: { value: unknown[] }) => timeline.push(...value);
      if (profiling) {
        cdp.on("Tracing.dataCollected", traceData);
        await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking", transferMode: "ReportEvents" });
        await cdp.send("Profiler.start");
      }
      const accepted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/operations") && response.ok());
      await send.click();
      if ("resizedHeight" in profile && profile.resizedHeight !== undefined) {
        await page.waitForFunction(() => (window as unknown as { __seekMeasurement: { nativeStarted: boolean } }).__seekMeasurement.nativeStarted);
        // Exercise changing scrollport bounds during the native animation,
        // approximating the viewport expansion as a software keyboard closes.
        for (const height of [580, 660, 740, profile.resizedHeight]) {
          await page.setViewportSize({ width: profile.width, height });
          await page.waitForTimeout(32);
        }
      }
      await accepted;
      // Capture the browser's animation plus the send acknowledgment
      // and initial streamed item. Timing is reported, never a machine gate.
      await page.waitForTimeout(1_200);
      const measurement = await page.evaluate(() => (window as unknown as {
        __seekMeasurement: { finish(): { frames: { at: number; top: number }[]; tasks: { at: number; duration: number }[]; turns: number } };
      }).__seekMeasurement.finish());
      if (profiling) {
        const { profile: cpuProfile } = await cdp.send("Profiler.stop");
        await writeFile(testInfo.outputPath(`seek-${expanded ? "expanded" : "initial"}.cpuprofile`), JSON.stringify(cpuProfile));
        const traceComplete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
        await cdp.send("Tracing.end");
        await traceComplete;
        cdp.off("Tracing.dataCollected", traceData);
        await writeFile(testInfo.outputPath(`seek-${expanded ? "expanded" : "initial"}.trace.json`), JSON.stringify({ traceEvents: timeline }));
      }
      const gaps = measurement.frames.slice(1).map((frame, index) => ({
        at: frame.at, milliseconds: frame.at - measurement.frames[index]!.at,
        pixels: frame.top - measurement.frames[index]!.top,
      })).filter((gap) => gap.milliseconds > 30 || gap.pixels < -1);
      reports.push({ expanded, ...measurement, gaps });
      console.log(JSON.stringify({ profile: profile.name, expanded, turns: measurement.turns, gaps, tasks: measurement.tasks }));
      if ("resizedHeight" in profile) {
        expect(gaps.filter((gap) => gap.pixels < -1), "viewport growth must not clamp seek backward").toEqual([]);
      }
      await expect.poll(() => page.locator(".message-viewport").evaluate((viewport) => {
        const users = viewport.querySelectorAll<HTMLElement>('[data-item-kind="user_message"]');
        return Math.abs(users[users.length - 1]!.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16);
      })).toBeLessThanOrEqual(1);
      await capture(page, testInfo, `seek-${profile.name}-${expanded ? "expanded" : "initial"}.png`);
      await page.waitForFunction(() => document.querySelector(".conversation-turn:last-child")?.getAttribute("data-turn-status") === "completed");
    }
    await writeFile(testInfo.outputPath("seek-performance.json"), JSON.stringify({ profile, reports }, null, 2));
    await cdp.detach();
  });
}

test("seek performance short thread viewport resize", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("sedes-seek-on-submit", "true");
    localStorage.setItem("sedes-chat-atmosphere", "false");
  });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await fillAndPersistDraft(page, "Bookmark the durable identity design");
  expect((await page.request.post("/__e2e/pi/bookmark/arm")).status()).toBe(204);
  try {
    await sendCurrentDraft(page);
    const turn = page.locator('.conversation-turn[data-turn-status="in_progress"]');
    await expect(turn).toHaveCount(1);
    await expect(turn.locator('[data-item-kind="assistant_message"]')).toContainText("I found", { timeout: 12_000 });
    const viewport = page.locator(".message-viewport");
    const geometry = () => viewport.evaluate((element) => {
      const content = element.querySelector<HTMLElement>(".message-content")!;
      const users = element.querySelectorAll<HTMLElement>('[data-item-kind="user_message"]');
      const target = users[users.length - 1]!;
      return {
        alignmentError: Math.abs(target.getBoundingClientRect().top - element.getBoundingClientRect().top - 16),
        contentHeight: content.getBoundingClientRect().height,
        viewportHeight: element.clientHeight,
        spacerHeight: element.querySelector<HTMLElement>(".seek-spacer")!.getBoundingClientRect().height,
        maximumScrollTop: element.scrollHeight - element.clientHeight,
      };
    });
    await expect.poll(async () => (await geometry()).alignmentError).toBeLessThanOrEqual(1);
    const initial = await geometry();
    // One short turn is held mid-response: the content fills the scrollport
    // through min-height, so viewport growth also changes its natural height.
    expect(Math.abs(initial.contentHeight - initial.viewportHeight)).toBeLessThanOrEqual(1);
    expect(initial.spacerHeight).toBeGreaterThan(0);
    for (const height of [920, 1000, 1100]) {
      await page.setViewportSize({ width: 390, height });
      await expect.poll(async () => (await geometry()).alignmentError).toBeLessThanOrEqual(1);
    }
    const expanded = await geometry();
    expect(expanded.viewportHeight).toBeGreaterThan(initial.viewportHeight);
    expect(Math.abs(expanded.contentHeight - expanded.viewportHeight)).toBeLessThanOrEqual(1);
    expect(expanded.spacerHeight).toBeGreaterThan(0);
    await capture(page, testInfo, "seek-short-thread-streaming-expanded.png");

    await viewport.press("End");
    await expect.poll(async () => (await geometry()).spacerHeight).toBe(0);
    // After returning to the live edge, later resizes must not revive the
    // former viewport-relative reservation as an empty scrollable tail.
    for (const height of [844, 1100]) {
      await page.setViewportSize({ width: 390, height });
      await expect.poll(async () => (await geometry()).spacerHeight).toBe(0);
      await expect.poll(async () => (await geometry()).maximumScrollTop).toBeLessThanOrEqual(1);
    }
    await capture(page, testInfo, "seek-short-thread-streaming-released.png");
  } finally {
    expect((await page.request.post("/__e2e/pi/bookmark/release")).status()).toBe(204);
  }
  await expect(page.locator('.conversation-turn[data-turn-status="completed"]')).toHaveCount(1, { timeout: 15_000 });
});
