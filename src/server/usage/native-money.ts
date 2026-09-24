import { usageMoneyAmountSchema } from "../../shared/protocol/usage-accounting.js";

/** Round an SDK number to the supported decimal scale before durable storage. */
export function nativeUsageMoney(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_native_usage_money");
  const [mantissa, exponentText = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponentText);
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer, decimal = ""] = expanded.split(".");
  let normalized = expanded;
  if (decimal.length > 18) {
    const units = BigInt(integer! + decimal.slice(0, 18)) + (decimal[18]! >= "5" ? 1n : 0n);
    const rounded = units.toString().padStart(19, "0");
    normalized = `${rounded.slice(0, -18)}.${rounded.slice(-18)}`;
  }
  normalized = normalized.includes(".") ? normalized.replace(/0+$/, "").replace(/\.$/, "") : normalized;
  if (!usageMoneyAmountSchema.safeParse(normalized).success) throw new Error("invalid_native_usage_money");
  return normalized;
}
