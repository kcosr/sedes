import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";

export type VariableEntry = EnvironmentVariableOverrides[string];
export type VariableScope = "environment" | "backend" | "agent" | "thread";
export type VariableLayer = { readonly scope: VariableScope; readonly values: EnvironmentVariableOverrides };
export const variableScopeLabels: Record<VariableScope, string> = {
  environment: "Environment", backend: "Backend", agent: "Agent", thread: "Thread",
};

export function variableRows(layers: readonly VariableLayer[]) {
  const rows = new Map<string, {
    name: string; entry: VariableEntry; scope: VariableScope;
    history: { scope: VariableScope; entry: VariableEntry }[];
  }>();
  for (const layer of layers) {
    for (const [name, entry] of Object.entries(layer.values)) {
      const history = [...(rows.get(name.toUpperCase())?.history ?? []), { scope: layer.scope, entry }];
      rows.set(name.toUpperCase(), { name, entry, scope: layer.scope, history });
    }
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function variableEntryLabel(entry: VariableEntry): string {
  if (entry.kind === "unset") return "Not set";
  if (entry.kind === "literal") return entry.value === "" ? "Empty string" : entry.value;
  return entry.source.kind === "environment"
    ? `Environment reference: ${entry.source.name}`
    : `Protected file: ${entry.source.path}`;
}
