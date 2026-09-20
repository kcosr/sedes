import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const metadata = { schemaVersion: 3, event: "turn.completed", notificationId: "test-id", title: "Done", message: "Thread", thread: { title: "Thread" } };
function run(payload: unknown) {
  return spawnSync("python3", ["scripts/notifications/sedes-notify-assistant.py", "--dry-run"], { input: JSON.stringify(payload), encoding: "utf8" });
}
describe("Assistant notification hook", () => {
  it("speaks selected sections in provisional, unclassified, final order regardless of key order", () => {
    const result = run({ ...metadata, assistantResult: {
      final: { text: "Final answer." },
      unclassified: { text: "Unclassified response." },
      provisional: { text: "Progress update." },
    } });
    expect(result.status).toBe(0);
    const base = JSON.parse(run(metadata).stdout).ttsText;
    expect(JSON.parse(result.stdout).ttsText).toBe(base + " Progress update. Unclassified response. Final answer.");
  });
  it.each([
    [{ final: { text: "Final only." } }, "Final only."],
    [{ provisional: { text: "Progress." }, final: { text: "Done." } }, "Progress. Done."],
    [{ unclassified: { text: "Grok response." } }, "Grok response."],
  ])("speaks only supplied sections %j", (assistantResult, expected) => {
    const result = run({ ...metadata, assistantResult });
    expect(result.status).toBe(0);
    const base = JSON.parse(run(metadata).stdout).ttsText;
    expect(JSON.parse(result.stdout).ttsText).toBe(base + " " + expected);
  });
  it.each([{}, { final: null }, { provisional: null, unclassified: { text: "" }, final: { text: "   " } }])("uses metadata speech when selected sections have no text %j", (assistantResult) => {
    const result = run({ ...metadata, assistantResult });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ttsText).toBe(JSON.parse(run(metadata).stdout).ttsText);
  });
  it("accepts truncation metadata and preserves final text", () => {
    const result = run({ ...metadata, assistantResult: { provisional: null, final: { text: "Shortened…", truncation: { truncated: true, retainedBytes: 12, reason: "byte_limit" } }, unclassified: null } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ttsText).toContain("Shortened…");
  });
  it("rejects the obsolete version and obsolete response shape", () => {
    expect(run({ ...metadata, schemaVersion: 1 }).status).toBe(1);
    expect(run({ ...metadata, schemaVersion: 2 }).status).toBe(1);
    expect(run({ ...metadata, assistantResult: { text: "Old aggregate" } }).status).toBe(1);
  });
});
