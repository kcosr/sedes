import { describe, expect, it } from "vitest";
import {
  MailboxClosedError,
  SerializedMailbox,
} from "../../src/server/conversations/serialized-mailbox.js";

describe("SerializedMailbox", () => {
  it("serializes events and mutations in acceptance order", async () => {
    const mailbox = new SerializedMailbox();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mailbox.enqueue(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = mailbox.enqueue(() => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after a failed operation", async () => {
    const mailbox = new SerializedMailbox();
    await expect(
      mailbox.enqueue(() => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await expect(mailbox.enqueue(() => 42)).resolves.toBe(42);
  });

  it("drains accepted work and rejects work offered after close", async () => {
    const mailbox = new SerializedMailbox();
    let finished = false;
    const accepted = mailbox.enqueue(async () => {
      await Promise.resolve();
      finished = true;
    });

    await mailbox.close();
    await accepted;
    expect(finished).toBe(true);
    expect(mailbox.closed).toBe(true);
    await expect(mailbox.enqueue(() => undefined)).rejects.toBeInstanceOf(
      MailboxClosedError,
    );
  });
});
