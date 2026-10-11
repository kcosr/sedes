export function reasoningLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Maximum";
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
