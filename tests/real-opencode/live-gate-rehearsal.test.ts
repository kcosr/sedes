import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runOpenCodeReadonlyGate } from "../support/opencode-live-gate-runner.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
import { RUN_REAL_OPENCODE } from "../support/opencode-native-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("rehearses the live gate against stock OpenCode with one exact model, bounded wire output and an allowed canary read", async () => {
  const model = await startOpencodeModelFixture();
  try {
    await runOpenCodeReadonlyGate({ executable: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2",
      model: "probe-model", baseURL: model.config.providers.probe.settings.baseURL,
      tokenField: "max_tokens", keyName: "FIXTURE_ONLY" }, "fixture-only", {
      canary: "Fixture response",
      beforeSubmit: ({ canaryFile }) => { model.callToolNextStream(`Read ${canaryFile}`, "read", { path: canaryFile }); },
    });
    expect(model.requestCount).toBe(2);
    expect(model.requests.map(request => request.model)).toEqual(["probe-model", "probe-model"]);
    expect(model.requests.every(request => request.maxTokens === 256 && request.maxCompletionTokens === undefined)).toBe(true);
    expect(model.requests[0]!.toolNames).toEqual(["read"]);
    expect(model.requests[1]!.toolChoice).toBe("none");
    expect(model.requests[1]!.toolResults.join("\n")).toContain("Fixture response");
  } finally { await model.stop(); }
});

it.runIf(RUN_REAL_OPENCODE)("fails qualification when the model attempts a read outside the allowed canary path", async () => {
  const model = await startOpencodeModelFixture();
  try {
    let failure: unknown;
    try {
      await runOpenCodeReadonlyGate({ executable: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2",
        model: "probe-model", baseURL: model.config.providers.probe.settings.baseURL,
        tokenField: "max_completion_tokens", keyName: "FIXTURE_ONLY" }, "fixture-only", {
        canary: "Fixture response",
        beforeSubmit: async ({ canaryFile, workspace }) => {
          const forbidden = path.join(workspace, "forbidden.txt");
          await writeFile(forbidden, "THIS MUST NOT REACH THE MODEL");
          model.callToolNextStream(`Read ${canaryFile}`, "read", { path: forbidden });
        },
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([expect.objectContaining({ message: "Canary read did not complete" })]);
    expect(model.requestCount).toBe(2);
    expect(model.requests.every(request => request.maxCompletionTokens === 256 && request.maxTokens === undefined)).toBe(true);
    expect(model.requests[0]!.toolNames).toEqual(["read"]);
    expect(model.requests[1]!.toolResults.join("\n")).toMatch(/denied|permission|Unable to read/iu);
    expect(model.requests[1]!.toolResults.join("\n")).not.toContain("THIS MUST NOT REACH THE MODEL");
  } finally { await model.stop(); }
});
