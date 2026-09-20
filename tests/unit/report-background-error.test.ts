import { describe, expect, it, vi } from "vitest";
import { reportBackgroundError } from "../../src/server/report-background-error.js";

describe("reportBackgroundError", () => {
  it("retains nested attachment causes through aggregate wrappers without cycling", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const native = new Error("sidecar_hello_build_mismatch");
      const unavailable = new Error("sidecar_unavailable", { cause: new AggregateError([native], "attachment failed") });
      native.cause = unavailable;
      reportBackgroundError("Host attachment")(unavailable);
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
        "Host attachment failed: sidecar_unavailable\n",
        "Host attachment cause: attachment failed\n",
        "Host attachment cause: sidecar_hello_build_mismatch\n",
      ]);
    } finally { write.mockRestore(); }
  });

  it("bounds cause count and line length without serializing arbitrary error data", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const errors = Array.from({ length: 100 }, () => new Error("x".repeat(5000)));
      errors[0]!.message = "first\nforged line\u001b";
      reportBackgroundError("Host attachment")(new AggregateError(errors, "attachment failed", { cause: { secret: "must_not_be_logged" } }));
      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      expect(lines).toHaveLength(16);
      expect(lines.join("")).toContain("first forged line ");
      expect(lines.join("")).not.toContain("must_not_be_logged");
      expect(lines.every(line => line.length < 2100 && line.split("\n").length === 2)).toBe(true);
    } finally { write.mockRestore(); }
  });

  it("writes a single diagnostic line for a plain error", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      reportBackgroundError("Deferred follow-up")(new Error("backend lost"));
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
        "Deferred follow-up failed: backend lost\n",
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it("unwraps AggregateError causes onto their own lines", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      reportBackgroundError("Authoritative completion follow-up")(
        new AggregateError(
          [new Error("recover failed"), new Error("wake failed")],
          "Authoritative completion follow-up did not finish cleanly.",
        ),
      );
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
        "Authoritative completion follow-up failed: Authoritative completion follow-up did not finish cleanly.\n",
        "Authoritative completion follow-up cause: recover failed\n",
        "Authoritative completion follow-up cause: wake failed\n",
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it("reports non-error rejections without throwing", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      reportBackgroundError("Deferred follow-up")({ unexpected: true });
      reportBackgroundError("Deferred follow-up")("string cause");
      expect(write.mock.calls.map(([chunk]) => chunk)).toEqual([
        "Deferred follow-up failed: unknown error\n",
        "Deferred follow-up failed: string cause\n",
      ]);
    } finally {
      write.mockRestore();
    }
  });
});
