// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticCategoryEnabled } from "./settings.js";
import {
  clearDiagnostics,
  copyDiagnostics,
  exportDiagnostics,
  readDiagnostics,
  recordComposerInputDiagnostic,
  recordSeekDiagnostic,
  recordStreamingDiagnostic,
  recordThreadLoadCategoryDiagnostic,
} from "./diagnostics.js";
import {
  beginThreadLoadAttempt,
  recordThreadLoadDiagnostic,
  resetThreadLoadAttemptsForTests,
} from "./thread-load-diagnostics.js";

afterEach(() => {
  clearDiagnostics();
  resetThreadLoadAttemptsForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("client diagnostics", () => {
  it("keeps composer input opt-in, exportable and out of the console", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    recordComposerInputDiagnostic("input", { textCharacters: 12 });
    expect(readDiagnostics()).toEqual([]);
    setDiagnosticCategoryEnabled("composer_input", true);
    recordComposerInputDiagnostic("input", {
      textCharacters: 12, isComposing: true, inputType: "insertCompositionText",
    });
    expect(readDiagnostics()).toHaveLength(1);
    expect(JSON.parse(exportDiagnostics()).enabledCategories).toEqual(["composer_input"]);
    expect(debug).not.toHaveBeenCalled();
  });

  it("keeps categories opt-in and strips unapproved details", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    recordSeekDiagnostic("snapshot_committed", { scrollTop: 10 });
    expect(readDiagnostics()).toEqual([]);

    setDiagnosticCategoryEnabled("seek", true);
    recordSeekDiagnostic(
      "seek_pin_engaged",
      {
        scrollTop: 120,
        pinActive: true,
        messageText: "must not escape",
      } as unknown as Parameters<typeof recordSeekDiagnostic>[1],
    );
    recordThreadLoadCategoryDiagnostic("stream_live");

    expect(readDiagnostics()).toEqual([
      expect.objectContaining({
        sequence: 1,
        category: "seek",
        event: "seek_pin_engaged",
        details: { scrollTop: 120, pinActive: true },
      }),
    ]);
    expect(debug).not.toHaveBeenCalled();
    expect(JSON.stringify(readDiagnostics())).not.toContain("must not escape");
  });

  it("correlates a load without exporting the application thread id", () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const attempt = beginThreadLoadAttempt(
      "private-application-thread-id",
      "navigation",
    );
    recordThreadLoadDiagnostic(attempt, "snapshot_json_parsed", {
      durationMilliseconds: 12.5,
    });

    const exported = exportDiagnostics();
    expect(exported).toContain('"attemptId": "load-1"');
    expect(exported).not.toContain("private-application-thread-id");
  });

  it("records streaming timings without accepting response content", () => {
    setDiagnosticCategoryEnabled("streaming", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    recordStreamingDiagnostic("sse_item_received", {
      arrivalGapMilliseconds: 150,
      eventDataCharacters: 512,
      itemKind: "assistant_message",
      itemStatus: "streaming",
      responseText: "private response",
    } as unknown as Parameters<typeof recordStreamingDiagnostic>[1]);

    expect(readDiagnostics()).toEqual([
      expect.objectContaining({
        category: "streaming",
        event: "sse_item_received",
        details: {
          arrivalGapMilliseconds: 150,
          eventDataCharacters: 512,
          itemKind: "assistant_message",
          itemStatus: "streaming",
        },
      }),
    ]);
    expect(exportDiagnostics()).not.toContain("private response");
  });

  it("bounds the shared trace and exports a copyable document", async () => {
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    for (let index = 0; index < 1_201; index += 1) {
      recordSeekDiagnostic("viewport_scrolled", { scrollTop: index });
    }
    const captured = readDiagnostics();
    expect(captured).toHaveLength(1_200);
    expect(captured[0]?.details.scrollTop).toBe(1);
    expect(captured.at(-1)?.details.scrollTop).toBe(1_200);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await copyDiagnostics();
    expect(writeText).toHaveBeenCalledOnce();
    expect(exportDiagnostics()).toContain(
      '"format": "sedes-client-diagnostics-v1"',
    );
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({
      format: "sedes-client-diagnostics-v1",
      entries: expect.arrayContaining([
        expect.objectContaining({ event: "viewport_scrolled" }),
      ]),
    });
  });
});
