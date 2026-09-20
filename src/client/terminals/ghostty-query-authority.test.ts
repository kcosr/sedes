// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { GhosttyEmulator } from "./ghostty-emulator.js";

beforeAll(() => {
  const backing = {
    canvas: undefined as HTMLCanvasElement | undefined,
    measureText: (text: string) => ({
      width: Math.max(1, Array.from(text).length) * 8,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
    }),
    createImageData: (width: number, height: number) => ({
      width, height, data: new Uint8ClampedArray(width * height * 4),
    }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      width, height, data: new Uint8ClampedArray(width * height * 4),
    }),
  };
  const context = new Proxy(
    backing,
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return () => undefined;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value);
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value() {
      backing.canvas = this;
      return context;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() { return 800; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return 400; },
  });
});

describe("Ghostty query-response authority", () => {
  it("does not forward Ghostty's DA/DSR responses as controller input", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const emulator = new GhosttyEmulator({ cursorBlink: true,
      fontSize: 13,
      scrollback: 100,
      colorScheme: "dark",
    });
    await emulator.mount(container);
    emulator.setController(true);
    const input: string[] = [];
    emulator.onInput((data) => input.push(data));

    emulator.write(new TextEncoder().encode("\x1b[c\x1b[5n\x1b[6n"));

    expect(input).toEqual([]);
    emulator.dispose();
  });
});
