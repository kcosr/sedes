import { createOpenCodeNativePortFixture, openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { expect, it, vi } from "vitest";
import type { ConversationHandle } from "../../src/server/backends/contracts.js";
import { NO_USAGE_CAPTURE, NO_USAGE_SINK, type UsageObservation, type UsageSink } from "../../src/server/usage/contracts.js";
import { OpenCodeUsageAccounting, openCodeUsageCheckpoint } from "../../src/server/backends/opencode/opencode-usage-accounting.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("captures persisted stock v2 usage, auxiliary title cost and compaction without double charging", async () => {
  const model = await startOpencodeModelFixture(); model.config.providers.probe.models["probe-model"].cost = { input: 1, output: 2 };
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let client: OpenCodeHttpClient | undefined, handle: ConversationHandle | undefined, accounting: OpenCodeUsageAccounting | undefined;
  const captured: UsageObservation[] = [];
  const sink: UsageSink = { ...NO_USAGE_SINK, enabled: true, open: () => ({ ...NO_USAGE_CAPTURE,
    capture: values => { captured.push(...values); return true; } }) };
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const environment = (await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576)).toString("utf8");
    const password = environment.split("\0").find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated native credential unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password });
    const port = createOpenCodeNativePortFixture(client, { directory: native.workspace, sessionID: "ses_m4_usage" });
    const api = new OpenCodeNativeApi(port), mutations = new OpenCodeNativeMutations(port);
    const session = await mutations.createSession({ id: "ses_m4_usage", location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" } }, openCodeTestMutationControl("create"));
    await vi.waitFor(async () => expect((await mutations.listModels(native!.workspace)).some(item => item.id === "probe-model")).toBe(true), { timeout: 20_000, interval: 25 });
    current = createOpenCodeConversationFixture({ native: { client, sessionID: session.id, directory: native.workspace } });
    vi.spyOn(current.repository, "hasCreatedRoot").mockReturnValue(false);
    accounting = new OpenCodeUsageAccounting(sink); current.context.usage = accounting;
    current.context.settings.updateDesired(scope, threadID, { expectedRevision: 0, desired: { providerID: "probe", id: "probe-model" }, now: Date.now() });
    handle = await current.driver.attach(current.target);
    await handle.establishProjection({ signal: new AbortController().signal });
    await handle.submit({ applicationOperationId: "usage-input", mutationId: "usage-input", reconciliationToken: "usage-input", source: { kind: "user" },
      text: "Explain the fixture usage", contextExcerpts: [], taskContexts: [], attachments: [] });
    // No projection refresh here: the actor must receive the ephemeral native
    // usage update from the title helper as well as ordinary durable steps.
    await vi.waitFor(async () => {
      const info = await api.getSession(session.id);
      expect(model.requests.length).toBeGreaterThanOrEqual(2);
      expect(info.title).not.toBe(session.title);
      expect(info.tokens.input).toBeGreaterThanOrEqual(40); expect(info.cost).toBeGreaterThan(0);
      const latest = captured.filter(item => item.replaceCheckpoint).at(-1);
      expect(latest?.facts).toEqual(openCodeUsageCheckpoint(info).facts);
      expect((await api.getActive())[session.id]).toBeUndefined();
    }, { timeout: 20_000, interval: 50 });
    const before = await api.getSession(session.id);
    const action = { action: "compact", applicationOperationId: "usage-compact" } as const;
    await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
    const receipt = current.repository.requireOperation(scope, threadID, action.applicationOperationId, "action");
    await vi.waitFor(async () => {
      const message = await api.getMessage(session.id, receipt.nativeInputId!);
      expect(message.type === "compaction" && message.status !== "running").toBe(true);
      const info = await api.getSession(session.id);
      expect(info.tokens.input).toBeGreaterThan(before.tokens.input);
      expect(captured.filter(item => item.replaceCheckpoint).at(-1)?.facts).toEqual(openCodeUsageCheckpoint(info).facts);
      expect(captured.some(item => item.facts.some(fact => fact.activity === "compaction" && fact.sessionContribution === "none"))).toBe(true);
    }, { timeout: 20_000, interval: 50 });
    expect(captured.flatMap(item => item.facts).filter(fact => fact.sessionContribution !== "none").every(fact => fact.id === "native-session-counter")).toBe(true);
    expect(captured.flatMap(item => item.facts).filter(fact => fact.turn).every(fact => fact.sessionContribution === "none")).toBe(true);
  } finally {
    await handle?.close(); accounting?.close();
    try { await current?.dispose(); } finally { client?.close(); try { await native?.stop(); } finally { await model.stop(); } }
    vi.restoreAllMocks();
  }
}, 90_000);
