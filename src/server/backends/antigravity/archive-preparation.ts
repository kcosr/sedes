import { createHash } from "node:crypto";
import { existingSidecarIsOffline } from "../../sidecar/runtime-channel.js";
import type { ConversationArchivePreparation, PrepareConversationArchiveInput } from "../contracts.js";
import type { AntigravityDriver } from "./driver.js";
import { projectAntigravityHistory } from "./history.js";
import type { AntigravityArchiveOwner, AntigravityArchiveProbe, AntigravityHistory, AntigravityIdentity } from "./port.js";
import { AntigravityUsage } from "./usage.js";

const busy = { outcome: "busy", reason: "Antigravity still has active work or a pending decision for this thread." } as const;
const inconclusive = { outcome: "inconclusive", reason: "Sedes could not verify all retained Antigravity output and operation results." } as const;

function sameOwner(expected: AntigravityArchiveOwner, actual: AntigravityArchiveOwner | null): boolean {
  return actual !== null && actual.handleId === expected.handleId && actual.generation === expected.generation &&
    actual.sessionId === expected.sessionId && actual.cwd === expected.cwd;
}

export async function prepareAntigravityArchive(driver: AntigravityDriver, input: PrepareConversationArchiveInput): Promise<ConversationArchivePreparation> {
  const detail = driver.validate(input);
  const { port } = driver.input;
  const identity = { sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath };
  if ([...driver.handles].some(handle => handle.binding.applicationThreadId === input.binding.applicationThreadId)) {
    input.markObserved();
    return { outcome: "inconclusive", reason: "The active Antigravity connection is still releasing this thread." };
  }

  let probe: AntigravityArchiveProbe | null;
  try { probe = await port.probeArchiveOwner(identity, input.signal); }
  catch (error) {
    if (!input.signal.aborted && !input.retainedOwner && existingSidecarIsOffline(error)) return { outcome: "offline" };
    return { outcome: "inconclusive", reason: "Sedes could not verify the Antigravity session on its execution host." };
  }
  input.signal.throwIfAborted();
  if (probe && (probe.sessionId !== identity.sessionId || probe.cwd !== identity.cwd)) {
    input.markObserved(); return inconclusive;
  }
  const ownerKey = probe ? createHash("sha256").update(JSON.stringify([probe.sessionId, probe.cwd, probe.handleId, probe.generation])).digest("hex") : undefined;
  const previouslyRetained = input.retainedOwner;
  if (probe && ownerKey && probe.retainedOutput && !previouslyRetained) input.markRetained(ownerKey);
  else if (probe) input.markObserved();
  if (previouslyRetained && previouslyRetained !== ownerKey) {
    try {
      const retired = await port.readRetiredArchive({ ...identity, ownerKey: previouslyRetained }, input.signal);
      if (!retired || retired.ownerKey !== previouslyRetained || retired.history.sessionId !== identity.sessionId || retired.history.cwd !== identity.cwd) return inconclusive;
      const correlations = await settleArchiveHistory(driver, input, retired.history);
      for (const { operation, outcome } of retired.operations) {
        if (outcome.status === "pending" || !driver.input.archiveReceipts?.apply(input, operation, outcome, correlations.has(operation.operationId), retired.setup)) return inconclusive;
      }
      if (retired.creation) {
        if (!driver.input.archiveReceipts?.creationBound(input, retired.creation)) return inconclusive;
        await port.acknowledgeCreation({ ...identity, operationId: retired.creation }, input.signal);
      }
      input.signal.throwIfAborted();
      input.markSettled(previouslyRetained);
      // An external or later application attachment can arrive during the
      // passive read. Re-evaluate the current generation before admission.
      return prepareAntigravityArchive(driver, { ...input, retainedOwner: undefined });
    } catch { return inconclusive; }
  }
  if (!probe || !ownerKey) return { outcome: "released" };
  const owner = { sessionId: probe.sessionId, cwd: probe.cwd, handleId: probe.handleId, generation: probe.generation };
  try {
    if (!probe.retainedOutput && !previouslyRetained) {
      const result = await port.retireSession({ ...identity, expected: owner }, input.signal);
      if (result === "retired") return { outcome: "released" };
      if (result === "busy") return busy;
      if (result !== "undelivered") return inconclusive;
    }
    if (!probe.retainedOutput || previouslyRetained) input.markRetained(ownerKey);
    let result: ConversationArchivePreparation;
    try {
      const claimed = await port.attachExisting({ ...identity, expected: owner }, input.signal);
      if (!sameOwner(owner, claimed)) return inconclusive;
      result = await drainArchiveOwner(driver, input, identity, owner);
    } finally {
      // A lost claim reply can still have marked the host attached. Releasing
      // the exact generation never stops a peer or consumes outstanding output.
      await port.releaseArchiveClaim(owner, AbortSignal.timeout(5000));
    }
    if (result.outcome === "released") input.markSettled(ownerKey);
    return result;
  } catch {
    return { outcome: "inconclusive", reason: "Sedes could not confirm Antigravity output delivery or release of its retained session." };
  }
}

async function drainArchiveOwner(driver: AntigravityDriver, input: PrepareConversationArchiveInput,
  identity: AntigravityIdentity, owner: AntigravityArchiveOwner): Promise<ConversationArchivePreparation> {
  const { port, archiveReceipts } = driver.input;
  const { signal } = input;
  while (true) {
    signal.throwIfAborted();
    const state = await port.readArchiveState(owner, signal);
    if (state.state === "changed") continue;
    if (state.state === "busy") return busy;
    if (state.state !== "idle" || state.history.sessionId !== owner.sessionId || state.history.cwd !== owner.cwd ||
        state.acknowledged > state.throughSequence) return inconclusive;

    // ACP deltas supply transient presentation and control hints. All durable
    // transcript/usage effects come from native history. Control outcomes and
    // permission inventory have their own retention independent of event pages.
    let through = state.acknowledged;
    while (through < state.throughSequence) {
      const page = await port.observe({ handleId: owner.handleId, afterSequence: through }, signal);
      if (page.activePromptIds.length) return busy;
      if (page.retainedAfterSequence > through || page.events.length === 0 ||
          page.throughSequence !== page.events.at(-1)?.sequence) return inconclusive;
      for (const event of page.events) {
        if (event.sequence !== through + 1 ||
            event.kind === "update" && event.notification.sessionId !== identity.sessionId ||
            event.kind === "permission" && event.request.sessionId !== identity.sessionId) return inconclusive;
        through = event.sequence;
        if (through === state.throughSequence) break;
      }
    }
    const correlations = await settleArchiveHistory(driver, input, state.history);
    signal.throwIfAborted();
    if (!sameOwner(owner, await port.probeArchiveOwner(identity, signal))) return inconclusive;
    // Keep the independent event cursor until the corresponding host receipts
    // have been applied. Replays of application writes use the same operation IDs.
    for (const operation of state.operations) {
      const target = { handleId: owner.handleId, operationId: operation.operationId };
      const outcome = await port.outcome(target, signal);
      if (outcome.status === "pending") return busy;
      if (!archiveReceipts?.apply(input, operation, outcome, correlations.has(operation.operationId), state.setup)) return inconclusive;
      signal.throwIfAborted();
      await port.acknowledgeOperation(target, signal);
    }
    if (state.pendingCreation) {
      if (!archiveReceipts?.creationBound(input, state.pendingCreation)) return inconclusive;
      await port.acknowledgeCreation({ ...identity, operationId: state.pendingCreation }, signal);
    }
    if (through > state.acknowledged) await port.acknowledge({ handleId: owner.handleId, throughSequence: through }, signal);
    signal.throwIfAborted();
    const released = await port.retireSession({ ...identity, expected: owner, settledNativeRevision: state.history.native.revision }, signal);
    if (released === "retired") return { outcome: "released" };
    if (released === "busy") return busy;
    if (released !== "undelivered") return inconclusive;
    // A new page or receipt arrived while settlement was in progress. It
    // belongs to the same user action and is covered by the same deadline.
  }
}

async function settleArchiveHistory(driver: AntigravityDriver, input: PrepareConversationArchiveInput, history: AntigravityHistory): Promise<ReadonlySet<string>> {
  const scope = { binding: driver.validate(input), key: driver.input.correlationKey };
  const projection = projectAntigravityHistory(history.native, scope);
  const usage = new AntigravityUsage(driver.input.usage, input.binding, driver.input.nativeNamespaceKey);
  try {
    if (!usage.update(history.native, projection, "history")) throw new Error("antigravity_archive_usage_uncommitted");
    const terminal = Object.values(projection.snapshot.turnsById).filter(turn => turn.status !== "in_progress");
    await input.settle(projection.snapshot, terminal.map(turn => turn.backendTurnId));
    input.signal.throwIfAborted();
    return new Set(terminal.flatMap(turn => turn.completionCorrelations ?? []));
  } finally { usage.close(); }
}
