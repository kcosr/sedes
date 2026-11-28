import { createHash } from "node:crypto";
import { existingSidecarIsOffline } from "../../sidecar/runtime-channel.js";
import type { AttachConversationInput, ConversationArchivePreparation, PrepareConversationArchiveInput } from "../contracts.js";
import type { AntigravityDriver } from "./driver.js";
import { projectAntigravityHistory } from "./history.js";
import type { AntigravityArchiveOwner, AntigravityArchiveProbe, AntigravityHistory, AntigravityIdentity } from "./port.js";
import { AntigravityUsage } from "./usage.js";

const busy = { outcome: "busy", reason: "Antigravity still has active work or a pending decision for this thread." } as const;
const inconclusive = { outcome: "inconclusive", reason: "Sedes could not verify all retained Antigravity output and operation results." } as const;

function sameOwner(expected: AntigravityArchiveOwner, actual: AntigravityArchiveOwner | AntigravityArchiveProbe | null): boolean {
  return actual !== null && "handleId" in actual && actual.handleId === expected.handleId && actual.generation === expected.generation &&
    actual.sessionId === expected.sessionId && actual.cwd === expected.cwd;
}

function archiveOwnerKey(owner: AntigravityArchiveOwner): string {
  return createHash("sha256").update(JSON.stringify([owner.sessionId, owner.cwd, owner.handleId, owner.generation])).digest("hex");
}

/** Ordinary open and close can finish the exact pending cut under the same
 * application fence, before normal observers consume its last receipts. */
export async function settleObservedAntigravityArchive(driver: AntigravityDriver, attached: AttachConversationInput, held?: AntigravityArchiveOwner): Promise<void> {
  const observer = driver.input.archiveObserver;
  const threadId = attached.binding.applicationThreadId;
  const retained = observer?.retained(threadId);
  if (!observer || !retained) return;
  const signal = AbortSignal.timeout(5000);
  try {
    const detail = driver.validate(attached);
    const identity = { sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath };
    if (retained.startsWith("creation:")) {
      const operationId = retained.slice("creation:".length);
      if (!driver.input.archiveReceipts?.creationBound(attached, operationId)) return;
      await driver.input.port.acknowledgeCreation({ ...identity, operationId }, signal);
      signal.throwIfAborted(); observer.release(threadId, retained);
      return;
    }
    const owner = await driver.input.port.probeArchiveOwner(identity, signal);
    if (!owner || !("handleId" in owner) || (held && !sameOwner(held, owner)) ||
        (archiveOwnerKey(owner) !== retained && !owner.inheritedOwners?.includes(retained)) || owner.sessionId !== identity.sessionId || owner.cwd !== identity.cwd) return;
    await drainArchiveOwner(driver, { ...attached, signal, retainedOwner: retained, markObserved() {}, markRetained() {},
      markSettled(key) { observer.release(threadId, key); },
      async settle(snapshot, ids) {
        if (observer.retained(threadId) !== retained) throw new Error("antigravity_archive_owner_changed");
        observer.settle(threadId, retained, snapshot, ids);
      } }, identity, owner, retained, false);
  } catch { /* A normal open/close remains usable. The exact pin survives an inconclusive read. */ }
}

export async function prepareAntigravityArchive(driver: AntigravityDriver, input: PrepareConversationArchiveInput): Promise<ConversationArchivePreparation> {
  const detail = driver.validate(input);
  const { port } = driver.input;
  const identity = { sessionId: detail.sessionId, cwd: detail.canonicalWorkspacePath };
  if ([...driver.handles].some(handle => handle.binding.applicationThreadId === input.binding.applicationThreadId)) {
    input.markObserved();
    return { outcome: "inconclusive", reason: "The active Antigravity connection is still releasing this thread." };
  }

  let found: AntigravityArchiveProbe | null;
  try { found = await port.probeArchiveOwner(identity, input.signal); }
  catch (error) {
    if (!input.signal.aborted && !input.retainedOwner && existingSidecarIsOffline(error)) return { outcome: "offline" };
    return { outcome: "inconclusive", reason: "Sedes could not verify the Antigravity session on its execution host." };
  }
  input.signal.throwIfAborted();
  if (found && (found.sessionId !== identity.sessionId || found.cwd !== identity.cwd)) {
    input.markObserved(); return inconclusive;
  }
  const previouslyRetained = input.retainedOwner;
  const orphan = found && "pendingCreation" in found ? found.pendingCreation : undefined;
  const outstandingCreation = previouslyRetained?.startsWith("creation:") ? previouslyRetained.slice("creation:".length) : !previouslyRetained ? orphan : undefined;
  if (outstandingCreation) {
    // Creation ACKs are retained independently of ACP sessions. Even after a
    // lost ACK reply the host must confirm the same scoped creation identity.
    const key = `creation:${outstandingCreation}`;
    input.markRetained(key);
    try {
      if ((orphan && orphan !== outstandingCreation) || !driver.input.archiveReceipts?.creationBound(input, outstandingCreation)) return inconclusive;
      await port.acknowledgeCreation({ ...identity, operationId: outstandingCreation }, input.signal);
      input.signal.throwIfAborted(); input.markSettled(key);
      return prepareAntigravityArchive(driver, { ...input, retainedOwner: undefined });
    } catch { return inconclusive; }
  }
  const probe = found && "handleId" in found ? found : null;
  const ownerKey = probe ? archiveOwnerKey(probe) : undefined;
  if (probe && ownerKey && probe.retainedOutput && !previouslyRetained) input.markRetained(ownerKey);
  else if (probe) input.markObserved();
  const inheritedPin = previouslyRetained && probe?.inheritedOwners?.includes(previouslyRetained) ? previouslyRetained : undefined;
  if (previouslyRetained && previouslyRetained !== ownerKey && !inheritedPin) {
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
    const pin = inheritedPin ?? ownerKey;
    if (!probe.retainedOutput || previouslyRetained) input.markRetained(pin);
    let result: ConversationArchivePreparation;
    try {
      const claimed = await port.attachExisting({ ...identity, expected: owner }, input.signal);
      if (!sameOwner(owner, claimed)) return inconclusive;
      result = await drainArchiveOwner(driver, input, identity, owner, pin, true);
    } finally {
      // A lost claim reply can still have marked the host attached. Releasing
      // the exact generation never stops a peer or consumes outstanding output.
      await port.releaseArchiveClaim(owner, AbortSignal.timeout(5000));
    }
    return result;
  } catch {
    return { outcome: "inconclusive", reason: "Sedes could not confirm Antigravity output delivery or release of its retained session." };
  }
}

async function drainArchiveOwner(driver: AntigravityDriver, input: PrepareConversationArchiveInput,
  identity: AntigravityIdentity, owner: AntigravityArchiveOwner, ownerKey: string, retire: boolean): Promise<ConversationArchivePreparation> {
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
    const operationIds = new Set([...state.operations.map(operation => operation.operationId), ...state.deliveredOperationIds]);
    let through = state.acknowledged;
    while (through < state.throughSequence) {
      const page = await port.observe({ handleId: owner.handleId, afterSequence: through }, signal);
      if (page.activePromptIds.length) return busy;
      if (page.retainedAfterSequence > through || page.events.length === 0 ||
          page.throughSequence !== page.events.at(-1)?.sequence) return inconclusive;
      for (const event of page.events) {
        if (event.sequence !== through + 1 ||
            event.kind === "operation" && !operationIds.has(event.operationId) ||
            event.kind === "update" && event.notification.sessionId !== identity.sessionId ||
            event.kind === "permission" && event.request.sessionId !== identity.sessionId) return inconclusive;
        through = event.sequence;
        if (through === state.throughSequence) break;
      }
    }
    const correlations = await settleArchiveHistory(driver, input, state.history, retire ? undefined : operationIds);
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
      await port.acknowledgeOperation({ ...target, archiveGeneration: owner.generation }, signal);
    }
    if (state.pendingCreation) {
      if (!archiveReceipts?.creationBound(input, state.pendingCreation)) return inconclusive;
      await port.acknowledgeCreation({ ...identity, operationId: state.pendingCreation }, signal);
    }
    if (through > state.acknowledged) await port.acknowledge({ handleId: owner.handleId, throughSequence: through }, signal);
    signal.throwIfAborted();
    if (!await port.confirmArchiveCut({ ...owner, throughSequence: through, nativeRevision: state.history.native.revision }, signal)) continue;
    // This cut is now applied and acknowledged. Record it before fallible
    // process cleanup so a lost final reply or host restart cannot revive it.
    input.markSettled(ownerKey);
    if (!retire) return { outcome: "released" };
    const released = await port.retireSession({ ...identity, expected: owner, settledNativeRevision: state.history.native.revision }, signal);
    if (released === "retired") return { outcome: "released" };
    if (released === "undelivered" || released === "busy") input.markRetained(ownerKey);
    if (released === "busy") return busy;
    if (released !== "undelivered") return inconclusive;
    // A new page or receipt arrived while settlement was in progress. It
    // belongs to the same user action and is covered by the same deadline.
  }
}

async function settleArchiveHistory(driver: AntigravityDriver, input: PrepareConversationArchiveInput, history: AntigravityHistory, inheritedOperations?: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const scope = { binding: driver.validate(input), key: driver.input.correlationKey };
  const projection = projectAntigravityHistory(history.native, scope);
  const usage = new AntigravityUsage(driver.input.usage, input.binding, driver.input.nativeNamespaceKey);
  try {
    if (!usage.update(history.native, projection, "history")) throw new Error("antigravity_archive_usage_uncommitted");
    // The ordinary observer owns later and unrelated history. Only first
    // observe a completion here when this cut contains its exact signed input.
    const terminal = Object.values(projection.snapshot.turnsById).filter(turn => turn.status !== "in_progress" &&
      (!inheritedOperations || turn.completionCorrelations?.some(id => inheritedOperations.has(id))));
    await input.settle(projection.snapshot, terminal.map(turn => turn.backendTurnId));
    input.signal.throwIfAborted();
    return new Set(terminal.flatMap(turn => turn.completionCorrelations ?? []));
  } finally { usage.close(); }
}
