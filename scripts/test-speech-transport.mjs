import { execFile, spawn } from "node:child_process";
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
    if ((await stat(report)).mtimeMs < began || counts.tests !== 7 || counts.failures !== 0 || counts.errors !== 0 || counts.skipped !== (live ? 6 : 1)) {
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
    elapsedMs: Date.now() - began, androidDeviceRun: false, liveProviderCalls: live ? "at most one speech and one transcription" : "none" }, null, 2) + "\n");
}
process.exitCode = exitCode;
