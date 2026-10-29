import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startOpenAiSpeechFixture } from "../tests/support/openai-speech-fixture.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.slice(2).includes("--live");
if (process.argv.slice(2).some(argument => argument !== "--live")) throw new Error("Usage: npm run test:speech -- [--live]");
if (live && (process.env.SEDES_RUN_LIVE_OPENAI_SPEECH !== "1" || !process.env.SEDES_SPEECH_TEST_API_KEY)) {
  throw new Error("Live speech requires SEDES_RUN_LIVE_OPENAI_SPEECH=1 and a dedicated SEDES_SPEECH_TEST_API_KEY supplied securely.");
}
await mkdir(path.join(root, "test-results"), { recursive: true });
const directory = await mkdtemp(path.join(root, "test-results", "speech-run-"));
console.log(`Speech transport artifacts: ${directory}`);
let primary, replacement, child;
let output = "";
let exitCode = 1;
let counts;
let interrupted = false;
const began = Date.now();
const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Extract actual codec packets so the JVM exercises the production streaming
 * Ogg writer. ffmpeg supplies the encoder only; MediaCodec requires a device. */
function opusPackets(ogg) {
  const packets = [];
  let pending = [];
  for (let offset = 0; offset < ogg.length;) {
    assert.equal(ogg.toString("ascii", offset, offset + 4), "OggS");
    const segments = ogg[offset + 26];
    let cursor = offset + 27 + segments;
    for (let index = 0; index < segments; index++) {
      const length = ogg[offset + 27 + index];
      assert(cursor + length <= ogg.length);
      pending.push(ogg.subarray(cursor, cursor + length)); cursor += length;
      if (length < 255) { packets.push(Buffer.concat(pending)); pending = []; }
    }
    assert(cursor > offset); offset = cursor;
  }
  assert.equal(pending.length, 0);
  assert.equal(packets[0].subarray(0, 8).toString(), "OpusHead");
  assert.equal(packets[1].subarray(0, 8).toString(), "OpusTags");
  return { opusHead: packets[0].toString("base64"), packets: packets.slice(2).map(packet => packet.toString("base64")) };
}

async function audioFixtures(pcm) {
  const ffmpeg = process.env.OPENAI_SPEECH_FFMPEG ?? "/usr/bin/ffmpeg";
  const fixturesDirectory = path.join(directory, "audio");
  await mkdir(fixturesDirectory);
  const rawArguments = ["-f", "s16le", "-ar", "24000", "-ac", "1"];
  async function normalized(name, source, inputArguments) {
    const target = path.join(fixturesDirectory, `${name}-normalized.pcm`);
    await execute(ffmpeg, ["-nostdin", "-v", "error", ...inputArguments, "-i", source, "-ac", "1", "-ar", "16000", "-f", "s16le", target]);
    const output = await readFile(target);
    return { normalizedPcmBytes: output.length, normalizedPcmSha256: hash(output) };
  }
  const originalPath = path.join(fixturesDirectory, "original.pcm");
  await writeFile(originalPath, pcm);
  const original = { pcm: pcm.toString("base64"), ...await normalized("original", originalPath, rawArguments) };
  const opus = [];
  // Both endings are deliberately between codec frames. The short second
  // recording detects leaked pre-skip, encoder state and final-page trimming.
  for (const [index, sourceSamples] of [27287, 3331].entries()) {
    const sourcePcm = Buffer.alloc(sourceSamples * 2);
    for (let sample = 0; sample < sourceSamples; sample++) {
      const signal = 4000 * Math.sin(2 * Math.PI * (index ? 733 : 431) * sample / 24000);
      sourcePcm.writeInt16LE(Math.round(signal), sample * 2);
    }
    const sourcePath = path.join(fixturesDirectory, `opus-${index}.pcm`);
    const oggPath = path.join(fixturesDirectory, `opus-${index}.ogg`);
    await writeFile(sourcePath, sourcePcm);
    await execute(ffmpeg, ["-nostdin", "-v", "error", ...rawArguments, "-i", sourcePath,
      "-c:a", "libopus", "-b:a", "24000", "-vbr", "off", "-application", "voip", "-frame_duration", "20", "-f", "ogg", oggPath]);
    const ogg = await readFile(oggPath);
    opus.push({ pcm: sourcePcm.toString("base64"), sourceSamples, ...opusPackets(ogg),
      ...await normalized(`opus-${index}`, oggPath, []) });
  }
  const manifest = path.join(fixturesDirectory, "fixtures.json");
  await writeFile(manifest, JSON.stringify({ original, opus }));
  return manifest;
}
const kill = signal => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
const stop = () => { interrupted = true; kill("SIGTERM"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  if (!live) {
    primary = await startOpenAiSpeechFixture(path.join(directory, "primary"));
    replacement = await startOpenAiSpeechFixture(path.join(directory, "replacement"));
  }
  const fixturePath = live ? "" : await audioFixtures(primary.pcm);
  if (interrupted) throw new Error("Speech transport verification interrupted");
  // Only the explicitly dedicated credential reaches the test worker. No ambient
  // OpenAI credential, provider config, or server runtime state is discovered.
  const environment = { ...process.env, SEDES_SPEECH_TRANSPORT_TEST: "1", SEDES_SPEECH_TEST_LIVE: live ? "1" : "0",
    SEDES_SPEECH_TEST_ENDPOINT: live ? "https://api.openai.com/v1" : primary.endpoint,
    SEDES_SPEECH_TEST_TOKEN: live ? process.env.SEDES_SPEECH_TEST_API_KEY : primary.token,
    SEDES_SPEECH_TEST_STT_MODEL: live ? process.env.SEDES_SPEECH_TEST_STT_MODEL ?? "gpt-live-transcribe" : "parakeet-local",
    SEDES_SPEECH_TEST_TTS_MODEL: live ? process.env.SEDES_SPEECH_TEST_TTS_MODEL ?? "gpt-4o-mini-tts" : "kokoro-local",
    SEDES_SPEECH_TEST_VOICE: live ? process.env.SEDES_SPEECH_TEST_VOICE ?? "coral" : "af_heart",
    SEDES_SPEECH_TEST_CONTROL_URL: primary?.controlUrl ?? "",
    SEDES_SPEECH_TEST_REPLACEMENT_ENDPOINT: replacement?.endpoint ?? "",
    SEDES_SPEECH_TEST_REPLACEMENT_TOKEN: replacement?.token ?? "",
    SEDES_SPEECH_TEST_PCM_SHA256: primary?.pcmSha256 ?? "",
    SEDES_SPEECH_TEST_AUDIO_FIXTURES: fixturePath,
  };
  delete environment.NODE_ENV;
  delete environment.OPENAI_API_KEY;
  delete environment.SEDES_SPEECH_TEST_API_KEY;
  child = spawn(path.join(root, "android", "gradlew"), [":app:testDebugUnitTest", "--tests", "dev.sedes.local.NativeVoiceSpeechIntegrationTest", "--console=plain", "--no-daemon"], {
    cwd: path.join(root, "android"), env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  // The Java smoke itself has a shorter deadline. This also bounds Gradle startup
  // or a stuck test worker and leaves the fixture shutdown in the finally path.
  const timer = setTimeout(() => { output += "\nHarness deadline exceeded.\n"; kill("SIGTERM"); }, 240_000);
  const force = setTimeout(() => kill("SIGKILL"), 250_000);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    output = (output + chunk.toString()).slice(-2 * 1024 * 1024);
    process.stdout.write(chunk);
  });
  try {
    exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
  } finally { clearTimeout(timer); clearTimeout(force); }
  if (exitCode === 0) {
    exitCode = 1;
    const report = path.join(root, "android/app/build/test-results/testDebugUnitTest/TEST-dev.sedes.local.NativeVoiceSpeechIntegrationTest.xml");
    const xml = await readFile(report, "utf8");
    counts = Object.fromEntries(["tests", "failures", "errors", "skipped"].map(key => [key, Number(new RegExp(`\\b${key}="(\\d+)"`).exec(xml)?.[1] ?? -1)]));
    if ((await stat(report)).mtimeMs < began || counts.tests !== 10 || counts.failures !== 0 || counts.errors !== 0 || counts.skipped !== (live ? 9 : 1)) {
      output += "\nExpected transport cases did not execute; inspect the focused JUnit XML report.\n";
    } else exitCode = 0;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const cleanup = await Promise.allSettled([primary?.close(), replacement?.close()]);
  if (cleanup.some(result => result.status === "rejected")) { exitCode = 1; output += "\nSpeech fixture cleanup failed.\n"; }
  await writeFile(path.join(directory, "jvm.log"), output);
  const revision = async cwd => {
    if (!cwd) return undefined;
    const git = promisify(execFile);
    const [head, state] = await Promise.all([git("git", ["rev-parse", "HEAD"], { cwd }), git("git", ["status", "--porcelain"], { cwd })]);
    return { revision: head.stdout.trim(), dirty: state.stdout.length > 0 };
  };
  const sources = { sedes: await revision(root), speechServer: live ? undefined : await revision(process.env.SEDES_SPEECH_SERVER_REPOSITORY) };
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ lane: live ? "live-openai" : "local-server", exitCode, counts, sources,
    elapsedMs: Date.now() - began, androidDeviceRun: false,
    opusEncoder: live ? undefined : "ffmpeg libopus fixture packets through native Java Ogg mux and transport; MediaCodec is not exercised",
    liveProviderCalls: live ? "at most one speech and one transcription" : "none" }, null, 2) + "\n");
}
process.exitCode = exitCode;
