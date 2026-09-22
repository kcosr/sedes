import { describe, expect, it } from "vitest";
import { nativeUsageMoney } from "../../src/server/usage/native-money.js";
import { usageMoneyAmountSchema } from "../../src/shared/protocol/usage-accounting.js";

describe("SDK money normalization", () => {
  it.each([
    [0, "0"], [0.0007 + 0.0002, "0.0009"], [17 * (0.3 / 1e6), "0.0000051"],
    [1e-18, "0.000000000000000001"], [5e-19, "0.000000000000000001"],
    [4e-19, "0"], [1e21, "1000000000000000000000"],
  ])("rounds %s to the supported decimal scale", (input, expected) => {
    expect(nativeUsageMoney(input)).toBe(expected);
    expect(usageMoneyAmountSchema.parse(nativeUsageMoney(input))).toBe(expected);
  });
  it.each([NaN, Infinity, -Infinity, -0.1, 1e38, Number.MAX_VALUE])("rejects invalid or overflowing money %s", value => {
    expect(() => nativeUsageMoney(value)).toThrow("invalid_native_usage_money");
  });
});
