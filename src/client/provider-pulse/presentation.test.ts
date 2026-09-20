import { describe, expect, it } from "vitest";
import type { ProviderPulseAccount } from "../../shared/protocol/provider-pulse.js";
import {
  accountRemainingPercent,
  accountShortLabel,
  accountUsageSummary,
  accountsByUpcomingReset,
  expiryText,
  remainingPercent,
  resetText,
  resetDayLabel,
  snapshotNote,
  usageBand,
  weeklyWindow,
} from "./presentation.js";

function account(
  windows: ProviderPulseAccount["usage"]["snapshot"] extends infer Snapshot
    ? Snapshot extends { windows: infer Windows }
      ? Windows
      : never
    : never,
): ProviderPulseAccount {
  return {
    id: "claude-work",
    label: "Claude · work",
    provider: "claude",
    usage: {
      health: "healthy",
      inFlight: false,
      snapshot: {
        observedAt: "2026-08-16T19:00:00.000Z",
        windows,
        balances: [],
      },
    },
  };
}

describe("provider pulse presentation", () => {
  it("uses the first normalized weekly window", () => {
    const selected = weeklyWindow(
      account([
        {
          id: "session",
          label: "Current session",
          remainingPercent: 90,
          durationMinutes: 300,
        },
        {
          id: "weekly-summary",
          label: "Current week",
          remainingPercent: 41,
          durationMinutes: 10_080,
        },
        {
          id: "weekly-secondary",
          label: "Secondary week",
          remainingPercent: 0,
          durationMinutes: 10_080,
        },
      ]),
    );
    expect(selected?.id).toBe("weekly-summary");
    expect(remainingPercent(selected)).toBe(41);
  });

  it("does not interpret provider-specific metric ids", () => {
    expect(
      weeklyWindow(
        account([
          {
            id: "opaque-first",
            label: "Primary",
            remainingPercent: 70,
            durationMinutes: 10_080,
          },
          {
            id: "opaque-second",
            label: "Secondary",
            remainingPercent: 100,
            durationMinutes: 10_080,
          },
        ]),
      )?.remainingPercent,
    ).toBe(70);
  });

  it("uses short account labels and capitalized reset copy", () => {
    expect(accountShortLabel(account([]))).toBe("work");
    expect(usageBand(8)).toBe("critical");
    expect(resetText("2026-08-20T03:37:02.000Z")).toMatch(/^Resets /);
    expect(
      resetDayLabel(
        new Date(2026, 7, 20, 12).toISOString(),
        new Date(2026, 7, 18, 12).getTime(),
      ),
    ).toBe("Thu");
    expect(resetDayLabel("not-a-timestamp")).toBeUndefined();
    expect(expiryText("2026-08-30T18:00:00.000Z")).toMatch(
      /^Next expires /,
    );
    expect(expiryText("not-a-timestamp")).toBeUndefined();
  });

  it("uses relative labels for resets today and tomorrow", () => {
    const now = new Date(2026, 7, 22, 23, 30).getTime();
    expect(resetDayLabel(new Date(2026, 7, 22, 1).toISOString(), now)).toBe(
      "today",
    );
    expect(resetDayLabel(new Date(2026, 7, 23, 0, 15).toISOString(), now)).toBe(
      "tomorrow",
    );
    expect(resetDayLabel(new Date(2026, 7, 24, 12).toISOString(), now)).toBe(
      "Mon",
    );
  });

  it("describes snapshot consumption", () => {
    expect(
      snapshotNote(20, {
        accountId: "claude-work",
        metricKind: "window",
        metricId: "weekly",
        remainingPercent: 27,
        capturedAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toMatch(/7% used since /);
  });

  it("omits an invalid baseline timestamp instead of throwing", () => {
    expect(
      snapshotNote(60, {
        accountId: "claude-work",
        metricKind: "window",
        metricId: "weekly",
        remainingPercent: 75,
        capturedAt: "not-a-timestamp",
      }),
    ).toBeUndefined();
  });

  it("uses a percentage balance when an account has no usage windows", () => {
    const balanceOnly = account([]);
    balanceOnly.usage.snapshot!.balances = [
      {
        id: "credits",
        label: "Credits",
        remainingPercent: 72,
        resetsAt: "2026-09-01T12:00:00.000Z",
      },
    ];
    expect(accountRemainingPercent(balanceOnly)).toBe(72);
    expect(accountUsageSummary(balanceOnly)).toEqual({
      remainingPercent: 72,
      resetsAt: "2026-09-01T12:00:00.000Z",
    });
  });

  it("orders upcoming resets first and leaves unavailable resets last", () => {
    const makeAccount = (
      id: string,
      resetsAt: string | undefined,
    ): ProviderPulseAccount => {
      const value = account([
        {
          id: "weekly",
          label: "Weekly",
          durationMinutes: 10_080,
          remainingPercent: 50,
          resetsAt,
        },
      ]);
      value.id = id;
      return value;
    };
    const later = makeAccount("later", "2026-08-25T12:00:00.000Z");
    const unavailable = makeAccount("unavailable", undefined);
    const soonest = makeAccount("soonest", "2026-08-23T12:00:00.000Z");
    const recentlyPast = makeAccount(
      "recently-past",
      "2026-08-21T12:00:00.000Z",
    );

    expect(
      accountsByUpcomingReset(
        [later, unavailable, recentlyPast, soonest],
        Date.parse("2026-08-22T12:00:00.000Z"),
      ).map(({ id }) => id),
    ).toEqual(["soonest", "later", "recently-past", "unavailable"]);
  });
});
