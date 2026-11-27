import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { build } from "vite";
import { startOpenAiSpeechFixture } from "../support/openai-speech-fixture.js";
import { SpeechTransport, type AudioChunk } from "../support/electron-speech-transport.js";

const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

it.runIf(process.env.SEDES_VOICE_DESKTOP_TIMING === "1")("measures ready-prefetched utterance boundaries on a continuous Chromium audio graph", async () => {
  const built = await build({ configFile: false, base: "./", logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { write: false, lib: {
    entry: path.resolve("tests/support/electron-playback-timing.ts"), formats: ["es"], fileName: () => "timing.mjs",
  } } });
  const bundles = Array.isArray(built) ? built : [built];
  const assets = new Map(bundles.flatMap(bundle => {
    if (!("output" in bundle)) throw new Error("Missing desktop timing library.");
    return bundle.output.map(asset => [asset.fileName, asset.type === "chunk" ? asset.code : asset.source] as const);
  }));
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    if (!name) {
      response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><button>Enable audio</button><script type="module">import {runDesktopTiming} from "./timing.mjs"; window.runDesktopTiming = runDesktopTiming;</script>');
      return;
    }
    const asset = assets.get(name);
    if (!asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/javascript" }).end(typeof asset === "string" ? asset : Buffer.from(asset));
  });
  await mkdir("test-results", { recursive: true });
  const directory = await mkdtemp(path.resolve("test-results/desktop-playback-timing-"));
  const speech = await startOpenAiSpeechFixture(directory);
  const browser = await chromium.launch().catch(async error => { await speech.close(); throw error; });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Desktop timing renderer did not bind.");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const mode of ["responsive", "off"] as const) {
      await speech.configure({ reset: true, ttsDurationSeconds: 1 });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      const transport = new SpeechTransport({ credentials: {
        async read(endpoint) { return endpoint === speech.endpoint ? speech.token : null; },
        async status(endpoint) { return { credentialConfigured: endpoint === speech.endpoint }; },
      }, notify(event, value) {
        if (event === "audioChunk") void page.evaluate(chunk => window.timingAudio?.(chunk), value as AudioChunk).catch(() => transport.cancelAll());
      } });
      try {
        await transport.configure({ endpoint: speech.endpoint, provider: "server" });
        await page.exposeFunction("timingSpeak", transport.speak.bind(transport));
        await page.exposeFunction("timingAck", transport.acknowledgeAudio.bind(transport));
        await page.exposeFunction("timingCancel", transport.cancel.bind(transport));
        await page.exposeFunction("timingCatalog", transport.getCapabilities.bind(transport));
        await page.goto(origin); await page.getByRole("button").click();
        expect(pageErrors).toEqual([]);
        const result = await page.evaluate(({ endpoint, mode }) =>
          window.runDesktopTiming(endpoint, mode, 35),
        { endpoint: speech.endpoint, mode });
        expect(result.requests).toEqual(result.sentences);
        expect((await speech.observations()).speech.map(entry => entry.text.trim())).toEqual(result.sentences);
        const ready = result.gapMs.filter((_gap, i) => result.readyLeadMs[i]! >= 500);
        const providerLimited = mode === "responsive" ? result.gapMs.filter((_gap, i) =>
          result.requestLeadMs[i]! >= 500 && result.readyLeadMs[i]! < 500) : [];
        const schedulingLimited = mode === "responsive" ? result.gapMs.filter((_gap, i) => result.requestLeadMs[i]! < 500) : [];
        const summary = { mode, sampleRate: result.sampleRate, measuredBoundaries: result.gapMs.length, readyBoundaries: ready.length,
          p95ReadyGapMs: ready.length ? p95(ready) : null, p95AllGapMs: p95(result.gapMs), firstFromEligibleMs: result.firstFromEligibleMs,
          textStarvedBoundaries: 0, providerLimitedBoundaries: providerLimited.length,
          p95ProviderLimitedGapMs: providerLimited.length ? p95(providerLimited) : null, schedulingLimitedBoundaries: schedulingLimited.length };
        await writeFile(path.join(directory, `${mode}.json`), JSON.stringify({ ...summary, gapMs: result.gapMs, readyLeadMs: result.readyLeadMs, requestLeadMs: result.requestLeadMs }, null, 2));
        console.log(`Desktop playback timing ${JSON.stringify(summary)} (${directory})`);
        expect(result.gapMs).toHaveLength(34);
        if (mode === "responsive") { expect(ready.length).toBeGreaterThanOrEqual(30); expect(p95(ready)).toBeLessThanOrEqual(250); }
      } finally { transport.cancelAll(); await page.close(); }
    }
  } finally {
    server.closeAllConnections();
    await Promise.all([browser.close(), speech.close(), new Promise<void>(resolve => server.close(() => resolve()))]);
  }
});
