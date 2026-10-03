import assert from "node:assert/strict";
import { execFile as execCallback, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { terminateChild } from "./production-carrier-fixture.js";

const execFile = promisify(execCallback);
export const VOICE_ADAPTER_REVISION = "74b9086cdf6e9a83426432a3ac4c5398dd557130";

export async function waitForVoice<T>(predicate: () => T | Promise<T>, timeout = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    await delay(20);
  }
  throw new Error("Voice fixture timed out");
}
async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** Real pinned adapter checkout, with its unchanged provider factories and media
 * controllers. Dummy credentials and a minimal environment prevent accidental
 * use of an operator's provider credentials or configuration. */
export async function startVoiceAdapterFixture(artifactDirectory: string) {
  const source = process.env.SEDES_VOICE_ADAPTER_REPOSITORY;
  if (!source) throw new Error("Set SEDES_VOICE_ADAPTER_REPOSITORY to an agent-voice-adapter Git checkout.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-voice-"));
  const checkout = path.join(directory, "adapter");
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime);
  await mkdir(artifactDirectory, { recursive: true });
  const environment = { PATH: process.env.PATH, HOME: runtime, TMPDIR: runtime, LANG: "C.UTF-8", TZ: "UTC",
    // Trust the host's configured certificate chain during dependency installation.
    ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  };
  let child: ChildProcess | undefined;
  let stub: Server | undefined;
  let wsStub: WebSocketServer | undefined;
  let logs = "";
  const errors: string[] = [];
  const texts: string[] = [];
  const wavs: Buffer[] = [];
  const transcripts: string[] = [];
  let asrDelay = 0;
  const pcm = Buffer.alloc(48_000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / 24_000)), i * 2);
  let ttsPcm = pcm;
  async function close() {
    if (child) await terminateChild(child);
    if (wsStub) {
      for (const socket of wsStub.clients) socket.terminate();
      await new Promise<void>(resolve => wsStub!.close(() => resolve()));
    }
    if (stub?.listening) {
      stub.closeAllConnections();
      await new Promise<void>(resolve => stub!.close(() => resolve()));
    }
    await writeFile(path.join(artifactDirectory, "adapter.log"), logs);
    await writeFile(path.join(artifactDirectory, "provider-observations.json"), JSON.stringify({
      revision: VOICE_ADAPTER_REVISION, texts, wavs: wavs.map(wav => ({ bytes: wav.length, sampleRate: wav.readUInt32LE(24) })), errors,
    }, null, 2));
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await execFile("git", ["clone", "--quiet", "--no-hardlinks", source, checkout], { env: environment });
    await execFile("git", ["checkout", "--quiet", "--detach", VOICE_ADAPTER_REVISION], { cwd: checkout, env: environment });
    // Keep the reference checkout untouched, including its dependency tree.
    const install = await execFile("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: checkout, env: environment, timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(artifactDirectory, "adapter-install.log"), install.stdout + install.stderr);
    await readFile(path.join(checkout, "node_modules/tsx/dist/loader.mjs"));
    await writeFile(path.join(runtime, "config.json"), "{}\n");
    stub = createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/audio/transcriptions");
        assert.equal(request.headers.authorization, "Bearer fixture-only-asr-key");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = await new Request("http://127.0.0.1/v1/audio/transcriptions", {
          method: "POST", headers: request.headers as Record<string, string>, body: Buffer.concat(chunks),
        }).formData();
        assert.equal(form.get("model"), "fixture-asr");
        assert.equal(form.get("response_format"), "json");
        const file = form.get("file"); assert(file instanceof File);
        const wav = Buffer.from(await file.arrayBuffer());
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        assert.equal(wav.toString("ascii", 8, 12), "WAVE");
        assert.equal(wav.readUInt32LE(24), 16_000);
        assert.equal(wav.readUInt16LE(22), 1);
        assert.equal(wav.readUInt16LE(34), 16);
        assert(wav.length > 44);
        wavs.push(wav);
        const text = transcripts.shift() ?? "";
        if (asrDelay) await delay(asrDelay);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text }));
      } catch (error) {
        errors.push(String(error)); response.writeHead(500).end("Fixture contract failure");
      }
    });
    wsStub = new WebSocketServer({ server: stub });
    wsStub.on("connection", (socket, request) => {
      try {
        const responsePcm = ttsPcm;
        const url = new URL(request.url!, "http://127.0.0.1");
        assert.equal(url.pathname, "/v1/text-to-speech/fixture-voice/stream-input");
        assert.equal(url.searchParams.get("model_id"), "fixture-tts");
        assert.equal(url.searchParams.get("output_format"), "pcm_24000");
        assert.equal(request.headers["xi-api-key"], "fixture-only-tts-key");
        let held = false;
        socket.on("message", data => {
          try {
            const message = JSON.parse(data.toString());
            if (message.generation_config) return;
            if (message.text) {
              texts.push(message.text); held ||= message.text.includes("hold-tts");
              socket.send(JSON.stringify({ audio: responsePcm.subarray(0, 4800).toString("base64") }));
            } else if (message.text === "" && !held) {
              socket.send(JSON.stringify({ audio: responsePcm.subarray(4800).toString("base64") }));
              socket.close(1000, "fixture-complete");
            }
          } catch (error) { errors.push(String(error)); socket.close(1011); }
        });
      } catch (error) { errors.push(String(error)); socket.close(1011); }
    });
    const providerPort = await listen(stub);
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", path.join(checkout, "node_modules/tsx/dist/loader.mjs"), path.join(checkout, "src/server/index.ts")], {
      cwd: runtime, stdio: ["ignore", "pipe", "pipe"], env: { ...environment,
        AGENT_VOICE_ADAPTER_CONFIG_FILE: path.join(runtime, "config.json"), LISTEN_HOST: "127.0.0.1", PORT: String(port),
        TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "fixture-only-tts-key", ELEVENLABS_TTS_BASE_URL: `http://127.0.0.1:${providerPort}/`,
        ELEVENLABS_TTS_VOICE_ID: "fixture-voice", ELEVENLABS_TTS_MODEL: "fixture-tts", ELEVENLABS_TTS_OUTPUT_FORMAT: "pcm_24000",
        ASR_PROVIDER: "openai", OPENAI_API_KEY: "fixture-only-asr-key", OPENAI_ASR_BASE_URL: `http://127.0.0.1:${providerPort}`,
        OPENAI_ASR_MODEL: "fixture-asr", OPENAI_ASR_TIMEOUT_MS: "10000", SESSION_DISPATCH_PROVIDER: "none", TTS_MAX_TEXT_CHARS: "5000",
      },
    });
    for (const output of [child.stdout, child.stderr]) output?.on("data", data => { logs = (logs + String(data)).slice(-1024 * 1024); });
    await waitForVoice(async () => {
      if (child!.exitCode !== null) throw new Error(`Adapter exited: ${logs}`);
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(250) })).ok; } catch { return false; }
    });
    return {
      url, port, texts, wavs, transcripts, errors, pcm,
      setAsrDelay(milliseconds: number) { asrDelay = milliseconds; },
      setTtsDurationSeconds(seconds: number) {
        assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 30);
        ttsPcm = Buffer.concat(Array.from({ length: seconds }, () => pcm));
      },
      async post(route: string, body: unknown) {
        const response = await fetch(url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        return { status: response.status, body: await response.json() };
      },
      async connect() {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const messages: Record<string, unknown>[] = [];
        socket.on("message", data => messages.push(JSON.parse(data.toString())));
        await once(socket, "open");
        const next = (type: string, requestId?: string) => waitForVoice(() => messages.find(message => message.type === type && (!requestId || message.requestId === requestId)));
        const identity = await next("client_identity");
        assert.equal(typeof identity.clientId, "string");
        socket.send(JSON.stringify({ type: "client_state_update", acceptingTurns: false, speechEnabled: true, listeningEnabled: false, inTurn: false, turnModeEnabled: false, directTtsEnabled: true, directSttEnabled: true }));
        const barrier = Date.now(); socket.send(JSON.stringify({ type: "client_ping", sentAtMs: barrier }));
        await waitForVoice(() => messages.find(message => message.type === "server_pong" && message.echoedSentAtMs === barrier));
        return { socket, messages, next, clientId: identity.clientId as string };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
