import { describe, expect, it } from "vitest";
import { pageFrameLayout, pageFrameMessage } from "./page-frame-layout.js";

describe("page viewport presentation", () => {
  it("preserves authored viewport pixels when scaling between clients", () => {
    expect(pageFrameLayout({ width: 1200, height: 800 }, 300, 400)).toEqual({
      width: 1200,
      height: 800,
      scale: 0.25,
      displayWidth: 300,
      displayHeight: 200,
    });
    expect(pageFrameLayout({ width: 390, height: 844 }, 900, 400)).toEqual({
      width: 390,
      height: 844,
      scale: 1,
      displayWidth: 390,
      displayHeight: 844,
    });
    expect(pageFrameLayout({ width: 1200 }, 300, 180, 2).width).toBe(1200);
  });

  it("uses the available width only when the author left sizing implicit", () => {
    expect(pageFrameLayout({}, 360, 230)).toEqual({
      width: 360,
      height: 230,
      scale: 1,
      displayWidth: 360,
      displayHeight: 230,
    });
    expect(pageFrameLayout({}, 760, 12_000).height).toBe(8192);
    expect(pageFrameLayout({ height: 600 }, 760, 250).height).toBe(600);
    expect(pageFrameLayout({}, 760, 28).height).toBe(28);
  });

  it("accepts bounded resize messages only from the exact frame and channel", () => {
    const source = {} as Window;
    const valid = { type: "sedes:page-size", channel: "secret", height: 320.2 };
    expect(pageFrameMessage({ source, data: valid }, source, "secret")).toEqual(
      { kind: "size", height: 321 },
    );
    expect(
      pageFrameMessage({ source: {} as Window, data: valid }, source, "secret"),
    ).toBeUndefined();
    expect(
      pageFrameMessage({ source, data: valid }, source, "other"),
    ).toBeUndefined();
    expect(
      pageFrameMessage(
        { source, data: { ...valid, height: Infinity } },
        source,
        "secret",
      ),
    ).toBeUndefined();
    expect(
      pageFrameMessage(
        { source, data: { ...valid, height: 1e8 } },
        source,
        "secret",
      ),
    ).toEqual({ kind: "size", height: 8192 });
    expect(
      pageFrameMessage(
        { source, data: { ...valid, height: 28 } },
        source,
        "secret",
      ),
    ).toEqual({ kind: "size", height: 28 });
    expect(
      pageFrameMessage(
        { source, data: { type: "sedes:page-error", channel: "secret" } },
        source,
        "secret",
      ),
    ).toEqual({ kind: "error" });
    expect(
      pageFrameMessage(
        { source, data: { type: "sedes:page-error", channel: "other" } },
        source,
        "secret",
      ),
    ).toBeUndefined();
    expect(pageFrameMessage({ source, data: { type: "sedes:page-wrapper-ready", channel: "secret" } }, source, "secret"))
      .toEqual({ kind: "wrapper-ready" });
    expect(pageFrameMessage({ source: {} as Window, data: { type: "sedes:page-wrapper-ready", channel: "secret" } }, source, "secret"))
      .toBeUndefined();
  });
});
