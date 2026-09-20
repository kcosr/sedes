import { describe, expect, it } from "vitest";
import {
  environmentAdmitsForegroundOperation,
  environmentOperationalState,
} from "../../src/server/domain/environment-operational-state.js";

describe("environment operational state", () => {
  it.each([
    {
      input: { availability: "available" as const, diagnosticCode: null },
      state: "available",
      admitted: true,
    },
    {
      input: {
        availability: "unavailable" as const,
        diagnosticCode: "ssh_environment_not_validated",
      },
      state: "unvalidated",
      admitted: true,
    },
    {
      input: {
        availability: "unavailable" as const,
        diagnosticCode: "sidecar_session_failed",
      },
      state: "unavailable",
      admitted: false,
    },
  ])("classifies $state environments", ({ input, state, admitted }) => {
    expect(environmentOperationalState(input)).toBe(state);
    expect(environmentAdmitsForegroundOperation(input)).toBe(admitted);
  });
});
