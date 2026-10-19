import { describe, expect, it } from "vitest";
import {
  MAXIMUM_RESIDENT_OPERATION_RECEIPTS,
  rememberBoundedReceipt,
} from "../../src/server/backends/bounded-receipts.js";

type Receipt = { readonly state: "accepted" | "outcome_unknown" };
const settled = (receipt: Receipt) => receipt.state === "accepted";

describe("bounded resident operation receipts", () => {
  it("caps accepted receipts at the resident limit by evicting the oldest", () => {
    const receipts = new Map<string, Receipt>();
    for (let index = 0; index <= MAXIMUM_RESIDENT_OPERATION_RECEIPTS; index += 1) {
      rememberBoundedReceipt(receipts, `operation-${index}`, { state: "accepted" }, settled);
    }
    expect(receipts.size).toBe(MAXIMUM_RESIDENT_OPERATION_RECEIPTS);
    expect(receipts.has("operation-0")).toBe(false);
    expect(receipts.has("operation-1")).toBe(true);
    expect(receipts.has(`operation-${MAXIMUM_RESIDENT_OPERATION_RECEIPTS}`)).toBe(true);
  });

  it("never evicts an unresolved receipt, even when it is the oldest", () => {
    const receipts = new Map<string, Receipt>();
    rememberBoundedReceipt(receipts, "unknown-1", { state: "outcome_unknown" }, settled, 3);
    rememberBoundedReceipt(receipts, "accepted-1", { state: "accepted" }, settled, 3);
    rememberBoundedReceipt(receipts, "unknown-2", { state: "outcome_unknown" }, settled, 3);
    rememberBoundedReceipt(receipts, "accepted-2", { state: "accepted" }, settled, 3);
    expect([...receipts.keys()]).toEqual(["unknown-1", "unknown-2", "accepted-2"]);
    rememberBoundedReceipt(receipts, "unknown-3", { state: "outcome_unknown" }, settled, 3);
    // Only unresolved receipts besides the newest remain; none may be dropped.
    expect([...receipts.keys()]).toEqual(["unknown-1", "unknown-2", "unknown-3"]);
    rememberBoundedReceipt(receipts, "unknown-4", { state: "outcome_unknown" }, settled, 3);
    expect(receipts.size).toBe(4);
  });

  it("refreshes a receipt that settles and evicts it only after newer receipts", () => {
    const receipts = new Map<string, Receipt>();
    rememberBoundedReceipt(receipts, "first", { state: "outcome_unknown" }, settled, 2);
    rememberBoundedReceipt(receipts, "second", { state: "accepted" }, settled, 2);
    rememberBoundedReceipt(receipts, "first", { state: "accepted" }, settled, 2);
    expect([...receipts]).toEqual([
      ["second", { state: "accepted" }],
      ["first", { state: "accepted" }],
    ]);
    rememberBoundedReceipt(receipts, "third", { state: "accepted" }, settled, 2);
    expect([...receipts.keys()]).toEqual(["first", "third"]);
  });
});
