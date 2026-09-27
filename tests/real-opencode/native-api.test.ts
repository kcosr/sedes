import { expect, it } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi, type OpenCodeNativeMessage, type OpenCodeNativeObservation } from "../../src/server/backends/opencode/opencode-native-api.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";

it.skipIf(!RUN_REAL_OPENCODE)("uses the production parser and SSE-first stream against stock v2 read/inventory/control endpoints without inference", async () => {
  const fixture = await startOpencodeNativeFixture();
  let client: OpenCodeHttpClient | undefined;
  let observation: OpenCodeNativeObservation | undefined;
  try {
    const entries = (await boundedOpenCodeProcessFile(`/proc/${fixture.pid}/environ`, 1_048_576)).toString("utf8").split("\0");
    const password = entries.find(value => value.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("fixture credential unavailable");
    client = new OpenCodeHttpClient({ endpoint: fixture.url, password });
    const api = new OpenCodeNativeApi(client);
    observation = api.observe(); await observation.ready;
    // Fixture-only creation/import seeds durable data; the production API
    // under test exposes no create, prompt, model selection or import method.
    const created = await fixture.api("POST", "/api/session", { title: "Read qualification", location: { directory: fixture.workspace } });
    expect(created.status).toBe(200);
    const sessionID: string = created.body.data.id;
    await expect(api.getSession(sessionID)).resolves.toMatchObject({ id: sessionID, location: { directory: fixture.workspace } });
    const listed = await api.listSessions({ directory: fixture.workspace, limit: 50 });
    expect(listed.data.some(session => session.id === sessionID)).toBe(true);
    const seededID = "ses_api_history_fixture";
    const messages: OpenCodeNativeMessage[] = Array.from({ length: 105 }, (_, index) => ({ id: `msg_api_${String(index).padStart(5, "0")}`, type: "synthetic", time: { created: index + 1 }, text: `Local record ${index}` }));
    const imported = await fixture.api("POST", "/api/experimental/session/import", {
      info: { ...created.body.data, id: seededID, title: "Seeded history" }, messages, location: { directory: fixture.workspace },
    });
    expect(imported.status).toBe(200);
    const seed: string = imported.body.data.id;
    const first = await api.getHistoryPage(seed, { order: "asc" });
    expect(first.data).toHaveLength(50);
    const second = await api.getHistoryPage(seed, { cursor: first.cursor.next! });
    expect(second.data).toHaveLength(50);
    const third = await api.getHistoryPage(seed, { cursor: second.cursor.next! });
    expect(third.data).toHaveLength(5);
    const end = await api.getHistoryPage(seed, { cursor: third.cursor.next! });
    expect(end).toMatchObject({ data: [], cursor: {} });
    expect([...first.data, ...second.data, ...third.data].map(value => value.type)).toEqual(messages.map(value => value.type));
    await expect(api.getMessage(seed, first.data[0]!.id)).resolves.toEqual(first.data[0]);
    const newest = await api.getHistoryPage(seed, { order: "desc", limit: 2 });
    const older = await api.getHistoryPage(seed, { cursor: newest.cursor.next!, limit: 2 });
    const forward = await api.getHistoryPage(seed, { cursor: older.cursor.previous!, limit: 2 });
    expect(forward.data).toEqual(newest.data);
    await expect(api.getPending(seed)).resolves.toEqual([]);
    await expect(api.getInteractions(seed)).resolves.toEqual({ permissions: [], forms: [] });
    await expect(api.getActivity(seed, fixture.workspace)).resolves.toMatchObject({ active: false, activeChildren: [], children: [], shells: [] });
    await expect(api.interruptSession(seed)).resolves.toEqual({ interrupted: false });
    const events = observation.drain();
    expect(events.some(({ event }) => event.type === "session.created")).toBe(true);
    expect(observation.failure).toBeUndefined();
  } finally { await observation?.close(); client?.close(); await fixture.stop(); }
});
