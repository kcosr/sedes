import type { PiNativeEvent } from "../port.js";

type Message = { readonly sequence: number; value?: unknown };
type Tool = { readonly sequence: number; value?: Record<string, unknown>; isError?: unknown; parentToolCallId?: string };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// Host snapshots use null-prototype JSON objects; schema-decoded snapshots may
// use ordinary objects. Compare only the already bounded JSON members.
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) &&
    sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** A prefix is disposable only after its output is present in an applied native
 * snapshot. Pending streams and requests fence that prefix even when later
 * entries have already reached disk. Operation receipts have separate ACKs. */
export class PiNativeEventCheckpoint {
  #candidate: number;
  #acknowledged: number;
  #observed: number;
  #messages: Message[] = [];
  #currentMessage?: Message;
  #tools = new Map<string, Tool>();
  #entries: { sequence: number; value: unknown }[] = [];
  #interactions = new Map<string, number>();
  #agentCalls = new Map<string, number>();
  #notices = new Set<number>();
  #unrecoverable: number[] = [];

  constructor(sequence: number) { this.#candidate = sequence; this.#acknowledged = sequence; this.#observed = sequence; }
  get acknowledged(): number { return this.#acknowledged; }

  observe({ sequence, kind, payload }: PiNativeEvent): void {
    if (sequence <= this.#observed) return;
    this.#observed = sequence;
    const type = payload.type;
    if (kind === "failure" || type === "failure") this.#unrecoverable.push(sequence);
    if (kind === "rpc" && type === "extension_error") this.#notices.add(sequence);
    if (kind === "stream") {
      if (type === "message_snapshot" || type === "toolcall_snapshot") this.#message(sequence);
      else this.#unrecoverable.push(sequence);
    }
    if (kind === "rpc") {
      if (type === "message_start") {
        this.#currentMessage = { sequence }; this.#messages.push(this.#currentMessage);
      } else if (type === "message_update") this.#message(sequence);
      else if (type === "message_end") {
        this.#message(sequence).value = payload.message; this.#currentMessage = undefined;
      } else if (type === "entry_appended") this.#entries.push({ sequence, value: payload.entry });
      if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(type))) {
        const id = String(payload.toolCallId);
        const tool = this.#tools.get(id) ?? { sequence }; this.#tools.set(id, tool);
        if (typeof payload.parentToolCallId === "string") tool.parentToolCallId = payload.parentToolCallId;
        if (type === "tool_execution_end") { tool.value = object(payload.result); tool.isError = payload.isError; }
      }
      if (type === "extension_ui_request" && typeof payload.id === "string") this.#interactions.set(payload.id, sequence);
    } else if (kind === "companion") {
      if (type === "tool_approval_requested" && typeof payload.id === "string") this.#interactions.set(payload.id, sequence);
      if (type === "tool_approval_closed" && typeof payload.id === "string") this.#interactions.delete(payload.id);
      if (type === "agent_tool_call" && typeof payload.id === "string") this.#agentCalls.set(payload.id, sequence);
      if (type === "agent_tool_cancelled" && typeof payload.id === "string") this.#agentCalls.delete(payload.id);
    }
  }

  applied(sequence: number, state: { readonly entries: readonly Readonly<Record<string, unknown>>[];
    readonly toolCalls: readonly Readonly<Record<string, unknown>>[]; readonly toolResults: readonly Readonly<Record<string, unknown>>[] }): void {
    this.#candidate = Math.max(this.#candidate, sequence);
    const messages = state.entries.filter(entry => entry.type === "message").map(entry => entry.message);
    this.#messages = this.#messages.filter(message => message.value === undefined ||
      !messages.some(value => sameJson(value, message.value)));
    this.#entries = this.#entries.filter(entry => !state.entries.some(value => sameJson(value, entry.value)));
    const results = [...state.toolResults, ...messages.filter(message => object(message).role === "toolResult")];
    for (const [id, tool] of this.#tools) {
      if (!tool.value) continue;
      if (results.some(value => {
        const result = object(value);
        return result.toolCallId === id && sameJson(result.content, tool.value!.content) &&
          sameJson(result.details, tool.value!.details) && result.isError === tool.isError;
      })) this.#tools.delete(id);
      // Stock Pi emits nested start/end progress even when lookup or argument
      // validation rejects the call before the companion's attestation hook.
      // Such progress is complete once the calling tool's result is durable;
      // it must never be promoted into an attested tool execution.
      else if (tool.parentToolCallId && !state.toolCalls.some(call => call.toolCallId === id) &&
        results.some(value => object(value).toolCallId === tool.parentToolCallId)) this.#tools.delete(id);
    }
  }

  noticeApplied(sequence: number): void {
    if (this.#notices.delete(sequence)) this.#candidate = Math.max(this.#candidate, sequence);
  }

  through(hasInteraction: (id: string) => boolean, hasPendingAgentCalls: boolean | undefined): number {
    for (const id of this.#interactions.keys()) if (!hasInteraction(id)) this.#interactions.delete(id);
    if (hasPendingAgentCalls === false) this.#agentCalls.clear();
    const barriers = [
      ...this.#messages.map(message => message.sequence), ...[...this.#tools.values()].map(tool => tool.sequence),
      ...this.#entries.map(entry => entry.sequence), ...this.#interactions.values(), ...this.#agentCalls.values(), ...this.#notices, ...this.#unrecoverable,
    ];
    return Math.max(this.#acknowledged, Math.min(this.#candidate, ...barriers.map(sequence => sequence - 1)));
  }

  acknowledge(sequence: number): void {
    this.#acknowledged = Math.max(this.#acknowledged, sequence);
    this.#candidate = Math.max(this.#candidate, sequence);
    this.#observed = Math.max(this.#observed, sequence);
    this.#messages = this.#messages.filter(message => message.sequence > sequence);
    if (this.#currentMessage && this.#currentMessage.sequence <= sequence) this.#currentMessage = undefined;
    this.#entries = this.#entries.filter(entry => entry.sequence > sequence);
    for (const [id, tool] of this.#tools) if (tool.sequence <= sequence) this.#tools.delete(id);
    for (const [id, start] of this.#interactions) if (start <= sequence) this.#interactions.delete(id);
    for (const [id, start] of this.#agentCalls) if (start <= sequence) this.#agentCalls.delete(id);
    for (const start of this.#notices) if (start <= sequence) this.#notices.delete(start);
    this.#unrecoverable = this.#unrecoverable.filter(start => start > sequence);
  }

  #message(sequence: number): Message {
    if (!this.#currentMessage) { this.#currentMessage = { sequence }; this.#messages.push(this.#currentMessage); }
    return this.#currentMessage;
  }
}
