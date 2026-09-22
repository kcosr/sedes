import type { UsageReport } from "../../shared/protocol/usage-accounting.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";

export interface UsageQueryState {
  readonly report?: UsageReport;
  readonly loading: boolean;
  readonly missing: boolean;
  readonly error?: string;
}
interface Entry {
  state: UsageQueryState;
  listeners: Set<() => void>;
  active: number;
  dirty: boolean;
  controller?: AbortController;
  minimumRevision: bigint;
}
/** Owned by one authenticated thread store; no data crosses server/principal lifetimes. */
export class UsageQueryCache {
  readonly #entries = new Map<string | null, Entry>();
  #disposed = false;
  #timer?: ReturnType<typeof setInterval>;
  #listening = false;
  constructor(readonly threadId: string, readonly api: Pick<ApiClient, "getUsage">) {}

  #entry(turnId: string | null): Entry {
    let entry = this.#entries.get(turnId);
    if (!entry) {
      entry = { state: { loading: false, missing: false }, listeners: new Set(), active: 0, dirty: false, minimumRevision: 0n };
      this.#entries.set(turnId, entry);
    }
    return entry;
  }
  getSnapshot = (turnId: string | null): UsageQueryState => this.#entry(turnId).state;
  subscribe(turnId: string | null, listener: () => void): () => void {
    const entry = this.#entry(turnId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  activate(turnId: string | null): () => void {
    const entry = this.#entry(turnId);
    entry.active++;
    this.#start();
    if (entry.active === 1) this.#refresh(turnId, entry);
    return () => { entry.active--; this.#stopIfIdle(); };
  }
  invalidate(revision?: string): void {
    if (this.#disposed) return;
    for (const [turnId, entry] of this.#entries) {
      if (revision !== undefined && BigInt(revision) <= BigInt(entry.state.report?.revision ?? "0")) continue;
      if (revision !== undefined && BigInt(revision) > entry.minimumRevision) entry.minimumRevision = BigInt(revision);
      if (entry.active) this.#refresh(turnId, entry);
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#stop();
    for (const entry of this.#entries.values()) { entry.controller?.abort(); entry.listeners.clear(); }
    this.#entries.clear();
  }
  #refresh(turnId: string | null, entry: Entry): void {
    if (this.#disposed || !entry.active || document.visibilityState === "hidden") return;
    if (entry.controller) { entry.dirty = true; return; }
    entry.dirty = false;
    const controller = new AbortController();
    entry.controller = controller;
    entry.state = { ...entry.state, loading: !entry.state.report && !entry.state.missing };
    this.#emit(entry);
    void this.api.getUsage(this.threadId, turnId, controller.signal).then(report => {
      if (this.#disposed || controller.signal.aborted || entry.controller !== controller) return;
      if (report.threadId !== this.threadId || report.turnId !== turnId) throw new Error("Usage response does not match this view.");
      if (BigInt(report.revision) < BigInt(entry.state.report?.revision ?? "0") || BigInt(report.revision) < entry.minimumRevision) {
        entry.state = { ...entry.state, loading: false, error: "Usage refresh is awaiting the latest recorded revision." };
        return;
      }
      entry.state = { report, loading: false, missing: false };
    }).catch((error: unknown) => {
      if (this.#disposed || controller.signal.aborted) return;
      if (turnId !== null && error instanceof ApiError && error.status === 404 && !entry.state.report) {
        entry.state = { loading: false, missing: true };
      } else {
        entry.state = { ...entry.state, loading: false, error: "Usage could not be refreshed. Previously recorded values are retained." };
      }
    }).finally(() => {
      if (this.#disposed || entry.controller !== controller) return;
      entry.controller = undefined;
      this.#emit(entry);
      if (entry.dirty) this.#refresh(turnId, entry);
    });
  }
  #emit(entry: Entry): void { for (const listener of entry.listeners) listener(); }
  readonly #refreshVisible = (): void => { if (document.visibilityState !== "hidden") this.invalidate(); };
  #start(): void {
    if (this.#disposed || this.#listening) return;
    this.#listening = true;
    this.#timer = setInterval(this.#refreshVisible, 5_000);
    window.addEventListener("focus", this.#refreshVisible);
    window.addEventListener("online", this.#refreshVisible);
    document.addEventListener("visibilitychange", this.#refreshVisible);
  }
  #stopIfIdle(): void { if (![...this.#entries.values()].some(entry => entry.active)) this.#stop(); }
  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#listening = false;
    window.removeEventListener("focus", this.#refreshVisible);
    window.removeEventListener("online", this.#refreshVisible);
    document.removeEventListener("visibilitychange", this.#refreshVisible);
  }
}
