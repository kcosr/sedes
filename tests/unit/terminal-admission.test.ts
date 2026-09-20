import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalAdmissionTokens } from "../../src/server/terminals/terminal-carrier.js";
import type { TerminalService } from "../../src/server/terminals/terminal-service.js";

const scope = { tenantId: "tenant", principalId: "principal" };

describe("TerminalAdmissionTokens", () => {
  it("is one-use and bound to server-derived scope and incarnation", () => {
    const service = {
      get() {
        return {
          terminalId: "11111111-1111-4111-8111-111111111111",
          incarnationId: "22222222-2222-4222-8222-222222222222",
          lifecycle: "running",
        };
      },
    } as unknown as TerminalService;
    const admissions = new TerminalAdmissionTokens(service);
    const issued = admissions.issue({
      scope,
      terminalId: "11111111-1111-4111-8111-111111111111",
      producerId: "33333333-3333-4333-8333-333333333333",
      requestedRole: "controller",
      restore: { kind: "checkpoint" },
    });
    expect(() =>
      admissions.consume(issued.token, {
        tenantId: "tenant",
        principalId: "other",
      }),
    ).toThrow("terminal_admission_invalid");
    expect(() => admissions.consume(issued.token, scope)).toThrow(
      "terminal_admission_invalid",
    );

    const second = admissions.issue({
      scope,
      terminalId: issued.terminalId,
      producerId: "33333333-3333-4333-8333-333333333333",
      requestedRole: "observer",
      restore: { kind: "resume", appliedSeq: 7 },
    });
    expect(admissions.consume(second.token, scope)).toMatchObject({
      terminalId: issued.terminalId,
      incarnationId: issued.incarnationId,
      requestedRole: "observer",
      restore: { kind: "resume", appliedSeq: 7 },
    });
    expect(() => admissions.consume(second.token, scope)).toThrow(
      "terminal_admission_invalid",
    );
  });

  it("expires tokens and denies terminals without an attachable incarnation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const available = serviceWith({ incarnationId: "22222222-2222-4222-8222-222222222222", lifecycle: "running" });
    const admissions = new TerminalAdmissionTokens(available);
    const issued = issue(admissions);
    vi.advanceTimersByTime(15_001);
    expect(() => admissions.consume(issued.token, scope)).toThrow(
      "terminal_admission_invalid",
    );

    for (const terminal of [
      { incarnationId: null, lifecycle: "starting" },
      { incarnationId: "22222222-2222-4222-8222-222222222222", lifecycle: "reserved" },
    ] as const) {
      const unavailable = new TerminalAdmissionTokens(serviceWith(terminal));
      expect(() => issue(unavailable)).toThrow("terminal_admission_unavailable");
    }
  });

  it("bounds outstanding unexpired admissions", () => {
    const admissions = new TerminalAdmissionTokens(serviceWith({
      incarnationId: "22222222-2222-4222-8222-222222222222",
      lifecycle: "running",
    }));
    for (let index = 0; index < 1_024; index += 1) issue(admissions);
    expect(() => issue(admissions)).toThrow("terminal_admission_capacity_exceeded");
  });
});

afterEach(() => vi.useRealTimers());

function serviceWith(terminal: { incarnationId: string | null; lifecycle: string }) {
  return { get: () => ({ terminalId: "11111111-1111-4111-8111-111111111111", ...terminal }) } as unknown as TerminalService;
}

function issue(admissions: TerminalAdmissionTokens) {
  return admissions.issue({
    scope,
    terminalId: "11111111-1111-4111-8111-111111111111",
    producerId: "33333333-3333-4333-8333-333333333333",
    requestedRole: "observer",
    restore: { kind: "checkpoint" },
  });
}
