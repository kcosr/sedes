// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { clearDiagnostics, exportDiagnostics, readDiagnostics } from "../app/diagnostics.js";
import { setDiagnosticCategoryEnabled } from "../app/settings.js";
import { recordVoiceSendDiagnostic, voiceDraftCounts } from "./voice-send-diagnostics.js";

const recordingId = "9ff27a42-814a-466b-acef-c8aeb7d017f5";
afterEach(() => { clearDiagnostics(); localStorage.clear(); vi.restoreAllMocks(); });

it("uses the Voice toggle and shared copy buffer without console output", () => {
  const debug = vi.spyOn(console, "debug");
  recordVoiceSendDiagnostic("handoff_received", { recordingId });
  expect(readDiagnostics()).toEqual([]);
  setDiagnosticCategoryEnabled("voice", true);
  recordVoiceSendDiagnostic("handoff_received", { recordingId });
  setDiagnosticCategoryEnabled("voice", false);
  recordVoiceSendDiagnostic("handoff_claimed", { recordingId });
  expect(JSON.parse(exportDiagnostics()).entries).toEqual([
    expect.objectContaining({ category: "voice", event: "handoff_received", details: { recordingId } }),
  ]);
  expect(debug).not.toHaveBeenCalled();
});

it("exports only counts, flags, fixed values and a random recording identifier", () => {
  setDiagnosticCategoryEnabled("voice", true);
  const draft = { text: "private speech", selectedSkillId: "private skill", taskReferences: [{ title: "private task" }],
    attachments: [{ fileName: "private file" }], contextExcerpts: [{ text: "private excerpt" }] };
  recordVoiceSendDiagnostic("draft_captured", { recordingId, ...voiceDraftCounts(draft), source: "live",
    ...{ threadId: "private thread", text: draft.text, error: "private failure" } });
  expect(readDiagnostics()[0]?.details).toEqual({ recordingId, source: "live", textCharacters: 14,
    taskCount: 1, attachmentCount: 1, excerptCount: 1, hasSkill: true });
  expect(exportDiagnostics()).not.toContain("private");
  for (const invalid of [{ recordingId: "private identifier" }, { taskCount: -1 }, { source: "private value" }]) {
    recordVoiceSendDiagnostic("draft_captured", invalid as never);
  }
  recordVoiceSendDiagnostic("private event" as never);
  expect(readDiagnostics()).toHaveLength(1);
});

it("does not let diagnostic failures change submission control flow", () => {
  setDiagnosticCategoryEnabled("voice", true);
  vi.spyOn(performance, "now").mockImplementation(() => { throw new Error("sink unavailable"); });
  expect(() => recordVoiceSendDiagnostic("handoff_received", { recordingId })).not.toThrow();
});
