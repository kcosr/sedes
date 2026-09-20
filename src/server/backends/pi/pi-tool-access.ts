/** Pi thread tool-access modes owned by Sedes persistence and presentation. */
import { PI_MUTATING_BUILTIN_TOOL_NAMES } from "./pi-builtin-tool-policy.js";

export type PiToolAccessMode = "read_only" | "ask" | "full";

export const PI_TOOL_ACCESS_MODES = [
  "read_only",
  "ask",
  "full",
] as const satisfies readonly PiToolAccessMode[];

export function isPiToolAccessMode(value: unknown): value is PiToolAccessMode {
  return value === "read_only" || value === "ask" || value === "full";
}

/**
 * Mutable desired/applied tool-access mode for one open Pi session.
 * `ask` keeps mutating tools active; the managed approval extension enforces
 * per-call prompts. Active tool names alone cannot distinguish `ask` from
 * `full`.
 */
export class PiToolAccessController {
  #mode: PiToolAccessMode;

  constructor(mode: PiToolAccessMode = "full") {
    this.#mode = mode;
  }

  get mode(): PiToolAccessMode {
    return this.#mode;
  }

  setMode(mode: PiToolAccessMode): void {
    this.#mode = mode;
  }
}

export const PI_PROTECTED_MUTATING_TOOLS: ReadonlySet<string> = new Set(
  PI_MUTATING_BUILTIN_TOOL_NAMES,
);

export const PI_TOOL_APPROVAL_TITLE = "Pi tool approval";
export const PI_TOOL_APPROVAL_APPROVE_LABEL = "Approve once";
export const PI_TOOL_APPROVAL_DENY_LABEL = "Deny";
export const PI_TOOL_APPROVAL_APPROVE_ACTION_ID = "approve_once";
export const PI_TOOL_APPROVAL_DENY_ACTION_ID = "deny";
