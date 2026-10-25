import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import model from "../../scripts/codex-probes/speed-fixture-model.json";
import {
  startMockResponsesServer,
  type MockResponseEvent,
} from "../../scripts/codex-probes/mock-responses-server.mjs";
import { buildCodexArguments } from "../../src/server/web-search/codex-cli-web-search-provider.js";
import { pinnedCodexTestExecutable } from "../helpers/pinned-codex-test-executable.js";
import { realBubblewrapTestsEnabled } from "../support/sandbox-test-gate.js";

interface NativeEvent {
  readonly type: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly type: string;
    readonly text?: string;
  };
}

interface NativeResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Current account models require this execution path. A fixture with only the
// older direct-tool metadata would miss an unavailable code-mode host.
const codeModeModel = {
  ...model,
  tool_mode: "code_mode_only",
  use_responses_lite: true,
  supports_search_tool: true,
  multi_agent_version: "v2",
};

// The native executable, home, model catalog, and Responses endpoint are all
// isolated. Only the loopback fixture receives requests; no provider auth is used.
// This file qualifies Linux enforcement, not macOS or Windows sandbox behavior.
describe.runIf(process.platform === "linux")("Codex web-search offline native boundary", () => {
  it.runIf(realBubblewrapTestsEnabled).each([
    { mode: "direct", metadata: model, codeMode: false },
    { mode: "code-mode-only", metadata: codeModeModel, codeMode: true },
  ])(
    "allows research-directory patches and blocks host, credential, and symlink escapes ($mode)",
    async ({ metadata, codeMode }) => {
      await withFixture(async (fixture) => {
        const outsideSentinel = path.join(fixture.outside, "sentinel.txt");
        const authSentinel = path.join(fixture.home, "auth-sentinel.txt");
        const outsideAdd = path.join(fixture.outside, "new.txt");
        await Promise.all([
          writeFile(outsideSentinel, "outside-original\n"),
          writeFile(authSentinel, "credential-original\n", { mode: 0o600 }),
          symlink(fixture.outside, path.join(fixture.workspace, "escape")),
        ]);

        const patches = [
          ["inside", addPatch("inside.txt", "inside-allowed")],
          ["outside-update", updatePatch(outsideSentinel, "outside-original", "outside-changed")],
          ["symlink-update", updatePatch("escape/sentinel.txt", "outside-original", "symlink-changed")],
          ["credential-update", updatePatch(authSentinel, "credential-original", "credential-changed")],
          ["outside-add", addPatch(outsideAdd, "outside-must-not-exist")],
        ] as const;
        for (const [id, patch] of patches) {
          fixture.provider.enqueue(codeMode
            ? customResponse(id, "exec", `await tools.apply_patch(${JSON.stringify(patch)}); text("PATCH_COMPLETED");`)
            : customResponse(id, "apply_patch", patch));
        }

        const result = await fixture.run();
        expectCompleted(result);
        expect(fixture.provider.requestCount).toBe(patches.length + 1);
        expect(await readFile(path.join(fixture.workspace, "inside.txt"), "utf8"))
          .toBe("inside-allowed\n");
        expect(await readFile(outsideSentinel, "utf8")).toBe("outside-original\n");
        expect(await readFile(authSentinel, "utf8")).toBe("credential-original\n");
        await expect(readFile(outsideAdd, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        // Check native tool outcomes as well as host-side file contents: an
        // ignored or unsupported tool call must not count as sandbox coverage.
        const outputs = lastToolOutputs(fixture.provider.requestBodies);
        expect(outputs.get("inside")).toContain(codeMode
          ? "PATCH_COMPLETED"
          : "Success. Updated the following files:");
        for (const id of ["outside-update", "symlink-update", "credential-update"]) {
          expect(outputs.get(id)).toMatch(/apply_patch verification failed: Failed to read file to update/u);
        }
        expect(outputs.get("outside-add"))
          .toContain("patch rejected: writing outside of the project; rejected by user approval settings");
      }, metadata);
    },
    30_000,
  );

  it("executes code-mode-only models without host filesystem globals or delegation tools", async () => {
    await withFixture(async (fixture) => {
      const authSentinel = path.join(fixture.home, "auth-sentinel.txt");
      const credential = "disposable-native-test-credential";
      await writeFile(authSentinel, credential, { mode: 0o600 });
      const code = `
text("CODE_MODE_OK");
text("HOST_GLOBALS:" + JSON.stringify(Object.fromEntries(
  ["process", "require", "Deno", "fetch", "fs", "readFile", "readFileSync"]
    .map(name => [name, typeof globalThis[name]])
)));
try {
  const fs = await import("node:fs");
  text("FS_IMPORT_UNEXPECTED:" + fs.readFileSync(${JSON.stringify(authSentinel)}, "utf8"));
} catch (error) {
  text("FS_IMPORT_DENIED:" + String(error));
}
text("AVAILABLE_TOOLS:" + JSON.stringify(ALL_TOOLS.map(tool => tool.name)));
`;
      fixture.provider.enqueue(customResponse("host-probe", "exec", code));
      const result = await fixture.run();
      expectCompleted(result);
      expect(fixture.provider.requestCount).toBe(2);
      const output = lastToolOutputs(fixture.provider.requestBodies).get("host-probe");
      expect(output).toContain("CODE_MODE_OK");
      expect(output).toContain('HOST_GLOBALS:{"process":"undefined","require":"undefined","Deno":"undefined","fetch":"undefined","fs":"undefined","readFile":"undefined","readFileSync":"undefined"}');
      expect(output).toMatch(/FS_IMPORT_DENIED:.*unsupported import in exec/iu);
      expect(output).not.toContain("FS_IMPORT_UNEXPECTED:");
      expect(output).not.toContain(credential);
      expect(output).not.toContain("spawn_agent");
      expect(output).not.toContain("exec_command");
      expect(output).toContain("apply_patch");
      expect(output).toContain("web__run");

      const request = JSON.parse(fixture.provider.requestBodies[0]!) as {
        readonly input: readonly { readonly type: string; readonly tools?: unknown }[];
      };
      const tools = request.input.find((item) => item.type === "additional_tools")?.tools;
      expect(tools).toBeDefined();
      expect(JSON.stringify(tools)).not.toContain('"name":"collaboration"');
      expect(await readFile(authSentinel, "utf8")).toBe(credential);
    }, codeModeModel);
  }, 30_000);

  it("resumes the exact saved session and rejects a missing session before inference", async () => {
    await withFixture(async (fixture) => {
      const fresh = await fixture.run();
      const sessionId = expectCompleted(fresh);
      const resumed = await fixture.run(sessionId);
      expect(expectCompleted(resumed)).toBe(sessionId);
      expect(fixture.provider.requestCount).toBe(2);

      const missingId = "00000000-0000-4000-8000-000000000123";
      const missing = await fixture.run(missingId);
      expect(missing.exitCode).toBe(1);
      expect(missing.signal).toBeNull();
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain(`no rollout found for thread id ${missingId}`);
      expect(fixture.provider.requestCount).toBe(2);
    });
  }, 30_000);
});

async function withFixture(
  use: (fixture: {
    readonly home: string;
    readonly workspace: string;
    readonly outside: string;
    readonly provider: Awaited<ReturnType<typeof startMockResponsesServer>>;
    run(resumeSessionId?: string): Promise<NativeResult>;
  }) => Promise<void>,
  fixtureModel: typeof model = model,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-web-search-native-"));
  let provider: Awaited<ReturnType<typeof startMockResponsesServer>> | undefined;
  try {
    const home = path.join(root, "home");
    const workspace = path.join(root, "research");
    const outside = path.join(root, "outside");
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(outside)]);
    const catalog = path.join(root, "models.json");
    await writeFile(catalog, JSON.stringify({ models: [fixtureModel] }));
    provider = await startMockResponsesServer();

    // These are the only overrides appended to the production arguments. They
    // select deterministic local inference without changing its research policy.
    const settings: Readonly<Record<string, string | number | boolean>> = {
      model: fixtureModel.slug,
      model_provider: "sedes_fixture",
      model_catalog_json: catalog,
      "model_providers.sedes_fixture.name": "Offline web-search qualification",
      "model_providers.sedes_fixture.base_url": provider.baseUrl,
      "model_providers.sedes_fixture.wire_api": "responses",
      "model_providers.sedes_fixture.requires_openai_auth": false,
      "model_providers.sedes_fixture.supports_websockets": false,
      "model_providers.sedes_fixture.supports_standalone_web_search": true,
      "model_providers.sedes_fixture.request_max_retries": 0,
      "model_providers.sedes_fixture.stream_max_retries": 0,
    };
    const fixtureArguments = Object.entries(settings)
      .flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
    const executable = pinnedCodexTestExecutable();
    await use({
      home,
      workspace,
      outside,
      provider,
      run: (resumeSessionId) => runNative(executable, [
        ...buildCodexArguments(resumeSessionId ? { resumeSessionId } : {}),
        ...fixtureArguments,
      ], workspace, home),
    });
  } finally {
    try {
      await provider?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function runNative(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
  home: string,
): Promise<NativeResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        CODEX_HOME: home,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8_000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    child.stdin.on("error", reject);
    child.stdin.end("Deterministic offline research fixture.\n");
  });
}

function expectCompleted(result: NativeResult): string {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).not.toContain("Code Mode is unavailable");
  const events = result.stdout.trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line) as NativeEvent);
  expect(events.at(-1)?.type).toBe("turn.completed");
  expect(events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message"))
    .toEqual([expect.objectContaining({ item: expect.objectContaining({ text: "fixture complete" }) })]);
  const sessionId = events.find((event) => event.type === "thread.started")?.thread_id;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
  return sessionId!;
}

function addPatch(file: string, value: string): string {
  return `*** Begin Patch\n*** Add File: ${file}\n+${value}\n*** End Patch`;
}

function updatePatch(file: string, before: string, after: string): string {
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n-${before}\n+${after}\n*** End Patch`;
}

function customResponse(id: string, name: string, input: string): readonly MockResponseEvent[] {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.done",
      item: { type: "custom_tool_call", call_id: id, name, input },
    },
    {
      type: "response.completed",
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
  ];
}

function lastToolOutputs(bodies: readonly string[]): Map<string, string> {
  const body = JSON.parse(bodies.at(-1)!) as {
    readonly input: readonly {
      readonly type: string;
      readonly call_id: string;
      readonly output: string | readonly { readonly text?: string }[];
    }[];
  };
  return new Map(body.input
    .filter((item) => item.type === "custom_tool_call_output")
    .map((item) => [item.call_id, typeof item.output === "string"
      ? item.output
      : item.output.map((content) => content.text ?? "").join("\n")]));
}
