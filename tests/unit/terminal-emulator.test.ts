import { describe, expect, it } from "vitest";
import { TerminalHeadlessEmulator } from "../../src/server/terminals/terminal-emulator.js";

describe("TerminalHeadlessEmulator", () => {
  it("is the pinned Unicode-11 authority for terminal device-query replies", async () => {
    const replies: string[] = [];
    const emulator = new TerminalHeadlessEmulator({
      rows: 24,
      columns: 80,
      onData: (bytes) => replies.push(Buffer.from(bytes).toString("utf8")),
    });
    await emulator.write(Buffer.from("\x1b[c")); // DA1
    await emulator.write(Buffer.from("\x1b[5n")); // DSR
    await emulator.write(Buffer.from("\x1b[?1$p")); // DECRQM
    await emulator.write(Buffer.from("\x1bP$qm\x1b\\")); // DECRQSS
    expect(replies).toEqual([
      "\x1b[?1;2c",
      "\x1b[0n",
      "\x1b[?1;2$y",
      "\x1bP1$r0m\x1b\\",
    ]);
    await emulator.write(Buffer.from("\x1b]4;1;?\x07"));
    await emulator.write(Buffer.from("\x1b]10;?\x07"));
    await emulator.write(Buffer.from("\x1b]11;?\x07"));
    await emulator.write(Buffer.from("\x1b]12;?\x07"));
    expect(replies).toHaveLength(8);
    expect(replies.filter((reply) => reply.startsWith("\u001b]4;1;rgb:"))).toHaveLength(1);
    expect(replies.filter((reply) => reply.startsWith("\u001b]10;rgb:"))).toHaveLength(1);
    expect(replies.filter((reply) => reply.startsWith("\u001b]11;rgb:"))).toHaveLength(1);
    expect(replies.filter((reply) => reply.startsWith("\u001b]12;rgb:"))).toHaveLength(1);
    emulator.dispose();
  });

  it("reports only parser-confirmed CSI 3 J after applying fragmented output", async () => {
    const emulator = new TerminalHeadlessEmulator({
      rows: 4,
      columns: 20,
      onData: () => undefined,
    });
    expect(await emulator.write(Buffer.from("old\r\n\x1b["))).toEqual({
      erasedScrollback: false,
    });
    expect(await emulator.write(Buffer.from("3Jnew"))).toEqual({
      erasedScrollback: true,
    });
    expect(await emulator.write(Buffer.from("\x1b[?3J\x1b[13J\x1b[J"))).toEqual({
      erasedScrollback: false,
    });
    const checkpoint = emulator.checkpoint();
    expect(checkpoint.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(checkpoint).toString("utf8")).toContain("new");
    emulator.dispose();
  });

  it("round-trips modes, alternate screen, wide cells, and combining marks", async () => {
    const create = () => new TerminalHeadlessEmulator({
      rows: 6,
      columns: 30,
      onData: () => undefined,
    });
    const source = create();
    await source.write(Buffer.from(
      "primary界e\u0301\x1b[?25l\x1b[?1049halt界e\u0301\x1b[2;4H",
      "utf8",
    ));
    const checkpoint = source.checkpoint();
    const restored = create();
    await restored.write(checkpoint);
    expect(Buffer.from(restored.checkpoint())).toEqual(Buffer.from(checkpoint));
    source.dispose();
    restored.dispose();
  });
});
