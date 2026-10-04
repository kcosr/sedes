import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForSpeech<T>(predicate: () => T | Promise<T>, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    await delay(20);
  }
  throw new Error("Speech fixture timed out");
}

export interface SpeechObservations {
  transcriptions: { sampleRate: number; bytes: number; sha256: string }[];
  speech: { text: string }[];
  cancelled: { transcription: number; speech: number };
}
type Ready = { type: "ready"; url: string; port: number; token: string; controlUrl: string; pcmSha256?: string };

/** Real local speech server, protocol, authorization and supervised workers.
 * Only model inference is replaced by the server repository's deterministic worker. */
export async function startOpenAiSpeechFixture(artifactDirectory: string) {
  const source = process.env.SEDES_SPEECH_SERVER_REPOSITORY;
  if (!source || !path.isAbsolute(source)) throw new Error("Set SEDES_SPEECH_SERVER_REPOSITORY to the absolute openai-speech-server checkout path.");
  const entry = path.join(source, "scripts/test-fixture.ts");
  const loader = path.join(source, "node_modules/tsx/dist/loader.mjs");
  await access(entry);
  await access(loader);
  await mkdir(artifactDirectory, { recursive: true });
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC",
    ...(process.env.PYTHON ? { PYTHON: process.env.PYTHON } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.OPENAI_SPEECH_FFMPEG ? { OPENAI_SPEECH_FFMPEG: process.env.OPENAI_SPEECH_FFMPEG } : {}),
  };
  const child = spawn(process.execPath, ["--import", loader, entry], { cwd: source, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let logs = "";
  let stdout = "";
  let ready: Ready | undefined;
  let failure: Error | undefined;
  child.on("error", error => { failure = error; });
  child.stdin.on("error", error => { if (child.exitCode === null && child.signalCode === null) failure = error; });
  child.stderr.on("data", chunk => { logs = (logs + String(chunk)).slice(-1024 * 1024); });
  child.stdout.on("data", chunk => {
    stdout += String(chunk);
    if (stdout.length > 65536) { failure = new Error("Speech fixture startup output exceeded its bound"); return; }
    let end;
    while ((end = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Ready;
        if (event.type !== "ready" || ready) throw new Error("Unexpected fixture startup event");
        const url = new URL(event.url), control = new URL(event.controlUrl);
        assert.equal(url.protocol, "http:"); assert.equal(control.protocol, "http:");
        assert.equal(url.hostname, "127.0.0.1"); assert.equal(control.hostname, "127.0.0.1");
        assert.equal(Number(url.port), event.port); assert.equal(typeof event.token, "string");
        assert(event.token.length > 0);
        ready = event;
      } catch { failure = new Error("Speech fixture emitted invalid startup metadata"); }
    }
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end('{"type":"shutdown"}\n');
      try { await waitForSpeech(() => child.exitCode !== null || child.signalCode !== null, 5000); }
      catch {
        child.kill("SIGTERM");
        try { await waitForSpeech(() => child.exitCode !== null || child.signalCode !== null, 2000); }
        catch { child.kill("SIGKILL"); await waitForSpeech(() => child.exitCode !== null || child.signalCode !== null, 2000); }
      }
    }
    await writeFile(path.join(artifactDirectory, "speech-server.log"), logs);
  }
  try {
    const event = await waitForSpeech(() => {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Speech fixture exited before readiness; inspect speech-server.log");
      return ready;
    }, 30_000);
    const headers = { authorization: `Bearer ${event.token}`, "content-type": "application/json" };
    const pcm = Buffer.alloc(48_000);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / 24_000)), i * 2);
    async function control<T>(body?: unknown): Promise<T> {
      const response = await fetch(event.controlUrl, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Speech fixture control failed: ${response.status}`);
      return await response.json() as T;
    }
    return { url: event.url, port: event.port, endpoint: `${event.url}/v1`, token: event.token, controlUrl: event.controlUrl,
      pcm, pcmSha256: event.pcmSha256 ?? createHash("sha256").update(pcm).digest("hex"),
      configure: (options: { transcripts?: string[]; asrDelayMs?: number; ttsDurationSeconds?: number; reset?: boolean }) => control<{ ok: true }>(options),
      observations: () => control<SpeechObservations>(),
      close,
    };
  } catch (error) { await close(); throw error; }
}
