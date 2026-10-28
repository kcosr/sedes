import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { SelectedAssistantResult, VoiceNotification, NotificationPolicy } from "../../shared/protocol/notification.js";
import type { ThreadInputContext } from "../../shared/protocol/thread-input.js";
import type { NativeReplySpeech, NativeVoiceSettings } from "./native-voice-plugin.js";

interface MarkdownNode {
  type: string; value?: string; alt?: string; identifier?: string; ordered?: boolean; start?: number; checked?: boolean | null;
  children?: MarkdownNode[];
}
const markdown = unified().use(remarkParse).use(remarkGfm);

/** Formatting is local presentation. The complete original text remains unchanged in Sedes. */
export function electronSpeechText(source: string, clean: boolean): string {
  if (!clean) return source.trim();
  let root: MarkdownNode;
  try { root = markdown.parse(source) as unknown as MarkdownNode; }
  catch { return ""; } // A parser limit drops this speech part, never the notification connection.
  const notes = new Map<string, number>();
  const output: string[] = [];
  const pending: Array<MarkdownNode | string> = [root];
  const children = (node: MarkdownNode, separator = "") => {
    const nodes = node.children ?? [];
    for (let index = nodes.length - 1; index >= 0; index--) {
      pending.push(nodes[index]!);
      if (index > 0 && separator) pending.push(separator);
    }
  };
  // Traverse iteratively: valid deeply nested Markdown must not overflow the
  // renderer stack or turn an ordinary reply into an invalid protocol frame.
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") { output.push(node); continue; }
    switch (node.type) {
      case "text": case "code": case "inlineCode": case "html": output.push(node.value ?? ""); break;
      case "image": case "imageReference": output.push(node.alt ?? ""); break;
      case "definition": break;
      case "footnoteReference": {
        const id = node.identifier ?? "";
        if (!notes.has(id)) notes.set(id, notes.size + 1);
        output.push(` [${notes.get(id)}]`); break;
      }
      case "footnoteDefinition": {
        const id = node.identifier ?? "";
        if (!notes.has(id)) notes.set(id, notes.size + 1);
        output.push(`[${notes.get(id)}] `); children(node, "\n\n"); break;
      }
      case "break": case "thematicBreak": output.push("\n\n"); break;
      case "root": case "blockquote": children(node, "\n\n"); break;
      case "list": {
        const nodes = node.children ?? [];
        for (let index = nodes.length - 1; index >= 0; index--) {
          pending.push(nodes[index]!);
          if (node.ordered) pending.push(`${(node.start ?? 1) + index}. `);
          if (index > 0) pending.push("\n\n");
        }
        break;
      }
      case "listItem":
        if (typeof node.checked === "boolean") output.push(node.checked ? "Checked. " : "Unchecked. ");
        children(node, "\n\n"); break;
      case "table": children(node, "\n\n"); break;
      case "tableRow": children(node, "; "); break;
      default: children(node);
    }
  }
  return output.join("").trim();
}

const resultParts = (result?: SelectedAssistantResult): string[] => {
  const parts: string[] = [];
  for (const phase of ["provisional", "partial", "unclassified", "final"] as const) {
    const value = result?.[phase];
    if (value?.text) parts.push(value.text);
    if (value?.truncation) parts.push("The remaining response was truncated.");
  }
  return parts;
};
const assemble = (parts: string[], settings: NativeVoiceSettings) => parts.map(text => electronSpeechText(text, settings.cleanSpeechText))
  .filter(Boolean).join(settings.cleanSpeechText ? "\n\n" : "\n");

export interface ElectronVoiceQueueItem {
  readonly id: string;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly event: string;
  readonly notification?: VoiceNotification;
  readonly replay?: NativeReplySpeech;
}
function renderVoiceItem(item: ElectronVoiceQueueItem, settings: NativeVoiceSettings): string {
  if (item.replay) return assemble(resultParts(item.replay.assistantResult), settings);
  const notice = item.notification;
  if (!notice || settings.audioMode !== "speak" || notice.voice === "none") return "";
  const payload = notice.payload;
  const parts = settings.speechContent === "messages" ? [] : [payload.title, payload.message];
  if (settings.speechContent !== "announcements") {
    if (payload.progress) {
      parts.push(payload.progress.text);
      if (payload.progress.truncation) parts.push("The remaining response was truncated.");
    } else if (payload.event === "turn.completed") parts.push(...resultParts(payload.assistantResult));
  }
  return assemble(parts, settings);
}
interface PreparedVoiceItem { presentation: string; text: string; bytes: number }
const preparedItems = new WeakMap<ElectronVoiceQueueItem, PreparedVoiceItem>();
const encoder = new TextEncoder();
/** Item sources are immutable for their lifetime. Cache only their current presentation, including after dequeue. */
function preparedVoiceItem(item: ElectronVoiceQueueItem, settings: NativeVoiceSettings): PreparedVoiceItem {
  const presentation = item.replay ? `replay:${settings.cleanSpeechText}`
    : `${settings.audioMode}:${settings.speechContent}:${settings.cleanSpeechText}`;
  const cached = preparedItems.get(item);
  if (cached?.presentation === presentation) return cached;
  const text = renderVoiceItem(item, settings);
  const prepared = { presentation, text, bytes: encoder.encode(text).byteLength };
  preparedItems.set(item, prepared);
  return prepared;
}
export function voiceItemText(item: ElectronVoiceQueueItem, settings: NativeVoiceSettings): string {
  return preparedVoiceItem(item, settings).text;
}

export function voiceChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const boundary = text.slice(start, end).search(/[.!?]\s+[^.!?]*$/u);
      if (boundary >= 0) end = start + boundary + 1;
      else {
        const word = text.slice(start, end).search(/\s+\S*$/u);
        if (word > 0) end = start + word + 1;
      }
      if (/^[\uDC00-\uDFFF]$/u.test(text[end] ?? "") && /^[\uD800-\uDBFF]$/u.test(text[end - 1] ?? "")) end--;
    }
    if (end <= start) throw new Error("Invalid speech text limit.");
    const chunk = text.slice(start, end);
    if (chunk.trim()) chunks.push(chunk);
    start = end;
  }
  return chunks;
}
export function notificationEligible(notice: VoiceNotification, policy: NotificationPolicy | null,
  settings: NativeVoiceSettings, clientId: string | null): boolean {
  if (settings.audioMode === "off" || !policy || !policy.settings.enabled || policy.settings.silenced ||
      notice.generation !== policy.generation || notice.voice === "none") return false;
  if (settings.ignoreOtherDevices && notice.origin && notice.origin.clientId !== clientId) return false;
  const target = notice.recognitionTarget?.threadId ?? notice.payload.thread?.id;
  return !settings.onlyVoiceThread || settings.voiceThreadId !== null && settings.voiceThreadId === target;
}
export function notificationListens(notice: VoiceNotification, settings: NativeVoiceSettings): boolean {
  return settings.autoListen && notice.voice === "speakThenListen" && !!notice.recognitionTarget &&
    (settings.audioMode !== "input" || notice.payload.event === "turn.completed");
}
export function automaticTargetCurrent(notice: VoiceNotification, context: ThreadInputContext): boolean {
  const target = notice.recognitionTarget;
  return !!target && target.threadId === context.threadId && context.authority === "current" && context.automaticListenEligible &&
    target.activityToken === context.activityToken && (notice.userInputRevision === undefined || context.userInputRevision <= notice.userInputRevision) &&
    (target.sourceTurnId === undefined || context.sourceTurnId === target.sourceTurnId);
}
export function stopCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\p{P}\p{S}]+$/gu, "").trim();
  return normalized === "stop" || normalized === "stop listening";
}

/** Bounded live queue. There is no replay of notifications missed while disconnected. */
export class ElectronVoiceQueue {
  readonly items: ElectronVoiceQueueItem[] = [];
  readonly seen = new Set<string>();
  readonly dropped: Record<string, number> = {};
  // The runtime may shift/splice/clear items directly. Summing cached sizes keeps
  // accounting accurate without reparsing Markdown or re-encoding speech on audio callbacks.
  bytes(settings: NativeVoiceSettings): number { return this.items.reduce((sum, item) => sum + preparedVoiceItem(item, settings).bytes, 0); }
  drop(reason: string): void { this.dropped[reason] = (this.dropped[reason] ?? 0) + 1; }
  add(item: ElectronVoiceQueueItem, settings: NativeVoiceSettings): boolean {
    if (item.notification) {
      if (this.seen.has(item.id) || this.items.some(pending => pending.id === item.id)) return false;
      this.seen.add(item.id);
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
      const notice = item.notification;
      if (notice.subjectId && (item.event === "thread.woke" || item.event.endsWith(".requested"))) {
        for (let index = this.items.length - 1; index >= 0; index--) {
          const old = this.items[index]!;
          if (old.threadId === item.threadId && old.event === item.event && old.notification?.subjectId === notice.subjectId) this.items.splice(index, 1);
        }
      }
    } else if (item.replay && this.items.some(old => old.replay?.threadId === item.replay!.threadId && old.replay.turnId === item.replay!.turnId)) return false;
    const bytes = preparedVoiceItem(item, settings).bytes;
    if (item.replay) {
      const remaining = this.items.filter(pending => pending.event !== "turn.progress");
      const remainingBytes = remaining.reduce((sum, pending) => sum + preparedVoiceItem(pending, settings).bytes, 0);
      if (remaining.length >= 64 || remainingBytes + bytes > 256 * 1024) throw new Error("Voice playback queue is full.");
    }
    const fits = () => this.items.length < 64 && this.bytes(settings) + bytes <= 256 * 1024;
    if (item.event !== "turn.progress") {
      for (let index = 0; !fits() && index < this.items.length;) {
        if (this.items[index]!.event === "turn.progress") { this.items.splice(index, 1); this.drop("progress_evicted"); }
        else index++;
      }
    }
    if (!fits()) { if (item.replay) throw new Error("Voice playback queue is full."); this.drop("overflow"); return false; }
    this.items.push(item); return true;
  }
  clearAutomatic(reason: string): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index]!.notification) { this.items.splice(index, 1); this.drop(reason); }
    }
  }
  /** Settings change presentation only. Rebuild queued text from original sources and reapply the same byte/item bounds. */
  reconfigure(settings: NativeVoiceSettings): string[] {
    const previous = this.items.splice(0);
    for (const item of previous) {
      if (!voiceItemText(item, settings) && (!item.notification || !notificationListens(item.notification, settings))) {
        if (item.notification) this.drop("settings_changed");
        continue;
      }
      // This is the already-admitted item, not a new delivery of its event.
      this.seen.delete(item.id);
      try { this.add(item, settings); }
      catch { /* A queued explicit replay may no longer fit after presentation settings change. */ }
    }
    return previous.filter(item => !this.items.some(current => current.id === item.id)).map(item => item.id);
  }
  reset(): void { this.items.length = 0; this.seen.clear(); for (const reason of Object.keys(this.dropped)) delete this.dropped[reason]; }
}
