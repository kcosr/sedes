import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/server/domain/errors.js";
import { projectApiError } from "../../src/server/http/errors.js";
import {
  callRuntime,
  normalizeRuntimeError,
  runtimeFailureCode,
} from "../../src/server/runtime/runtime-errors.js";

describe("runtime error normalization", () => {
  it.each([
    ["workspace_missing", "workspace_missing", false],
    ["workspace_not_allowed", "invalid_transition", false],
    ["execution_environment_unavailable", "runtime_unavailable", true],
    ["an unexpected provider failure", "runtime_unavailable", true],
  ] as const)(
    "maps %s to the stable %s domain contract",
    (runtimeCode, domainCode, retryable) => {
      const normalized = normalizeRuntimeError(new Error(runtimeCode));
      expect(normalized).toMatchObject({
        code: domainCode,
        retryable,
      });
      expect(runtimeFailureCode(normalized)).toBe(runtimeCode);
    },
  );

  it("preserves an existing domain error and normalizes async failures", async () => {
    const domainError = new DomainError("conflict", "already normalized");
    expect(normalizeRuntimeError(domainError)).toBe(domainError);
    expect(runtimeFailureCode(domainError)).toBeUndefined();
    await expect(
      callRuntime(async () => {
        throw new Error("workspace_not_allowed");
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "The workspace is outside the configured execution roots.",
    });
  });

  it("bounds cyclic aggregate causes at the public error boundary", () => {
    const cyclic = new AggregateError([], "cyclic cleanup failure");
    Object.defineProperty(cyclic, "cause", { value: cyclic });

    expect(projectApiError(cyclic)).toEqual({
      status: 500,
      body: {
        error: {
          code: "internal_error",
          message: "The request could not be completed.",
          retryable: false,
        },
      },
    });
  });
});
