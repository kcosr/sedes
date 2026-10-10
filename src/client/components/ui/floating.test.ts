import { describe, expect, it } from "vitest";
import {
  FLOATING_COLLISION_PADDING,
  SUBMENU_SIDE_OFFSET,
  submenuOffsetBesideParent,
} from "./floating.js";

describe("submenuOffsetBesideParent", () => {
  // A 280px panel whose rows run 1104–1380, each ending in a 32px button.
  const rows = { left: 1104, right: 1380 };
  const trigger = { left: 1348, right: 1380 };

  it("opens on the right beside a trailing trigger when it fits there", () => {
    expect(
      submenuOffsetBesideParent({ trigger, rows, submenuWidth: 144, viewportWidth: 1920 }),
    ).toBe(SUBMENU_SIDE_OFFSET);
  });

  it("clears the panel's rows when it flips to the left near the viewport edge", () => {
    const offset = submenuOffsetBesideParent({
      trigger,
      rows,
      submenuWidth: 144,
      viewportWidth: 1440,
    });
    // As far left of the trigger as a row-wide trigger's submenu would be.
    expect(offset).toBe(SUBMENU_SIDE_OFFSET + trigger.left - rows.left);
    const submenuRight = trigger.left - offset;
    expect(submenuRight).toBeLessThan(rows.left);
  });

  it("measures the right side from the end of the rows for an inset trigger", () => {
    expect(
      submenuOffsetBesideParent({
        trigger: { left: 1300, right: 1332 },
        rows,
        submenuWidth: 144,
        viewportWidth: 1920,
      }),
    ).toBe(SUBMENU_SIDE_OFFSET + rows.right - 1332);
  });

  it("keeps the trigger's offset when neither side has room", () => {
    expect(
      submenuOffsetBesideParent({
        trigger: { left: 268, right: 300 },
        rows: { left: 24, right: 300 },
        submenuWidth: 144,
        viewportWidth: 312 + FLOATING_COLLISION_PADDING,
      }),
    ).toBe(SUBMENU_SIDE_OFFSET);
  });

  it("uses the caller's offset and collision padding", () => {
    expect(
      submenuOffsetBesideParent({
        trigger,
        rows,
        submenuWidth: 144,
        viewportWidth: 1380 + 4 + 144 + 20,
        sideOffset: 4,
        collisionPadding: 20,
      }),
    ).toBe(4);
    expect(
      submenuOffsetBesideParent({
        trigger,
        rows,
        submenuWidth: 144,
        viewportWidth: 1380 + 4 + 144 + 19,
        sideOffset: 4,
        collisionPadding: 20,
      }),
    ).toBe(4 + trigger.left - rows.left);
  });
});
