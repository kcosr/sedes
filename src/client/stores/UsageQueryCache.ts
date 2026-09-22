import type { UsageReport } from "../../shared/protocol/usage-accounting.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";

export interface UsageQueryState {
  readonly report?: UsageReport;
  readonly available?: boolean;
  readonly loading: boolean;
  readonly missing: boolean;
  readonly error?: string;
}
interface Entry {
  state: UsageQueryState;
  listeners: Set<() => void>;
  active: number;
  availabilityActive: number;
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
  #availabilityTimer?: ReturnType<typeof setTimeout>;
  #availabilityController?: AbortController;
  #availabilityDirty = false;
  constructor(readonly threadId: string, readonly api: Pick<ApiClient, "getUsage" | "getUsageAvailability">) {}

  #entry(turnId: string | null): Entry {
    let entry = this.#entries.get(turnId);
    if (!entry) {
      entry = { state: { loading: false, missing: false }, listeners: new Set(), active: 0, availabilityActive: 0, dirty: false, minimumRevision: 0n };
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
  /** Presence checks batch terminal rows; detailed accounting is fetched only on open. */
  activateAvailability(turnId:string):()=>void {
    const entry=this.#entry(turnId);entry.availabilityActive++;
    this.#start();this.#scheduleAvailability();
    return ()=>{entry.availabilityActive--;this.#stopIfIdle();};
  }
  #scheduleAvailability():void {
    if(this.#disposed || ![...this.#entries.values()].some(entry=>entry.availabilityActive))return;
    if(this.#availabilityController){this.#availabilityDirty=true;return;}
    if(this.#availabilityTimer!==undefined)return;
    this.#availabilityTimer=setTimeout(()=>{this.#availabilityTimer=undefined;void this.#refreshAvailability();},0);
  }
  async #refreshAvailability():Promise<void> {
    if(this.#disposed || document.visibilityState==="hidden")return;
    const turnIds=[...this.#entries].filter(([id,entry])=>id!==null && entry.availabilityActive).map(([id])=>id!);
    if(!turnIds.length)return;
    const controller=new AbortController();this.#availabilityController=controller;this.#availabilityDirty=false;
    try {
      for(let index=0;index<turnIds.length;index+=100){
        const batch=turnIds.slice(index,index+100);
        const result=await this.api.getUsageAvailability(this.threadId,batch,controller.signal);
        if(this.#disposed || controller.signal.aborted)return;
        if(result.threadId!==this.threadId || result.turns.length!==batch.length || new Set(result.turns.map(turn=>turn.turnId)).size!==batch.length || result.turns.some(turn=>!batch.includes(turn.turnId)))throw new Error("Usage availability does not match this view.");
        for(const turn of result.turns){
          const entry=this.#entry(turn.turnId);
          if(BigInt(result.revision)<entry.minimumRevision || BigInt(result.revision)<BigInt(entry.state.report?.revision??"0"))continue;
          entry.minimumRevision=BigInt(result.revision);
          if(entry.state.available!==turn.available){entry.state={...entry.state,available:turn.available};this.#emit(entry);}
        }
      }
    }catch{/* Hidden actions retry on the next revision, focus, or visible poll. */}
    finally {
      if(this.#availabilityController===controller)this.#availabilityController=undefined;
      if(this.#availabilityDirty)this.#scheduleAvailability();
    }
  }
  invalidate(revision?: string): void {
    if (this.#disposed) return;
    this.#scheduleAvailability();
    for (const [turnId, entry] of this.#entries) {
      if (revision !== undefined && BigInt(revision) <= BigInt(entry.state.report?.revision ?? "0")) continue;
      if (revision !== undefined && BigInt(revision) > entry.minimumRevision) entry.minimumRevision = BigInt(revision);
      if (entry.active) this.#refresh(turnId, entry);
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#stop();
    clearTimeout(this.#availabilityTimer);this.#availabilityController?.abort();
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
      entry.state = { ...entry.state, report, loading: false, missing: false, error:undefined };
    }).catch((error: unknown) => {
      if (this.#disposed || controller.signal.aborted) return;
      if (turnId !== null && error instanceof ApiError && error.status === 404 && !entry.state.report) {
        entry.state = { ...entry.state, loading: false, missing: true };
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
  #stopIfIdle(): void { if (![...this.#entries.values()].some(entry => entry.active || entry.availabilityActive)) { this.#stop();clearTimeout(this.#availabilityTimer);this.#availabilityTimer=undefined;this.#availabilityController?.abort(); } }
  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#listening = false;
    window.removeEventListener("focus", this.#refreshVisible);
    window.removeEventListener("online", this.#refreshVisible);
    document.removeEventListener("visibilitychange", this.#refreshVisible);
  }
}
