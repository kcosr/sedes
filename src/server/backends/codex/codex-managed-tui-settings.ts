import { deterministicJson } from "../../canonical-json.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import { codexThreadResumeMethod } from "./codex-c1-protocol.js";
import {
  codexC2NotificationSchemas,
  codexThreadSettingsUpdateMethod,
} from "./codex-c2-protocol.js";
import { codexExecutionPolicy } from "./codex-execution-policy.js";
import { assertCodexLiveModelSelection, type CodexLiveModelSelection } from "./codex-live-model-selection.js";
import type { CodexManagedTuiLaunchSettings } from "./codex-managed-tui-launcher.js";
import type { CodexManagedTuiBindingAuthority } from "./codex-managed-tui-registry.js";
import { encodeCodexServiceTier } from "./codex-service-tier.js";

const SETTINGS_CONFIRMATION_TIMEOUT_MILLISECONDS = 10_000;

/**
 * Remote resume restores the daemon's saved permission policy. Apply the full
 * desired tuple there before opening the PTY, and confirm it by authoritative
 * readback: the empty update response only acknowledges queuing, and a no-op
 * update does not publish a settings notification.
 * This changes future-turn settings without interrupting an active turn.
 */
export async function prepareCodexManagedTuiThreadSettings(input: {
  readonly client: CodexSharedClientFacade;
  readonly authority: CodexManagedTuiBindingAuthority;
  readonly settings: CodexManagedTuiLaunchSettings;
  readonly signal: AbortSignal;
}): Promise<CodexLiveModelSelection> {
  const { client, authority, settings, signal } = input;
  const assertCurrent = () => {
    if (signal.aborted) throw signal.reason;
    const lifecycle = client.lifecycleSnapshot();
    if (lifecycle.state !== "ready" || lifecycle.generation !== authority.appServerGeneration) {
      throw new Error("codex_tui_settings_generation_changed");
    }
  };
  assertCurrent();
  const modelSelection = await assertCodexLiveModelSelection({
    client,
    expectedGeneration: authority.appServerGeneration,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    signal,
  });
  assertCurrent();
  const policy = codexExecutionPolicy(settings).turn;
  const params = {
    threadId: authority.backendConversationId,
    cwd: authority.canonicalWorkspacePath,
    approvalPolicy: policy.approvalPolicy,
    approvalsReviewer: policy.approvalsReviewer,
    sandboxPolicy: policy.sandboxPolicy,
    model: settings.model,
    serviceTier: encodeCodexServiceTier(settings.serviceTier),
    effort: settings.reasoningEffort,
  };
  const matches = (actual: { cwd: unknown; model: unknown; effort: unknown;
    serviceTier: unknown; approvalPolicy: unknown; approvalsReviewer: unknown;
    sandboxPolicy: unknown }) => actual.cwd === params.cwd && actual.model === params.model &&
    actual.effort === params.effort && actual.serviceTier === params.serviceTier &&
    actual.approvalPolicy === params.approvalPolicy &&
    actual.approvalsReviewer === params.approvalsReviewer &&
    // Official decoding uses null-prototype objects. Compare JSON values on
    // both the server and the sidecar's supported Node runtime.
    deterministicJson(actual.sandboxPolicy) === deterministicJson(params.sandboxPolicy);
  let latestObservation: { sequence: number; matches: boolean } | undefined;
  let confirmationError: unknown;
  let confirm!: () => void;
  let reject!: (error: unknown) => void;
  const confirmed = new Promise<void>((resolve, fail) => {
    confirm = resolve;
    reject = error => { confirmationError = error; fail(error); };
  });
  // A notification or disconnect may arrive before the request continuation.
  void confirmed.catch(() => undefined);
  const removeNotification = client.subscribeNotifications(notification => {
    if (notification.generation !== authority.appServerGeneration ||
        notification.method !== "thread/settings/updated") return;
    if (notification.kind === "undecodable_notification") {
      if (notification.nativeThreadId === authority.backendConversationId) {
        reject(new Error("codex_tui_settings_confirmation_invalid"));
      }
      return;
    }
    if (typeof notification.params !== "object" || notification.params === null ||
        !("threadId" in notification.params) ||
        notification.params.threadId !== authority.backendConversationId) return;
    let parsed: ReturnType<typeof codexC2NotificationSchemas["thread/settings/updated"]["parse"]>;
    try { parsed = codexC2NotificationSchemas["thread/settings/updated"].parse(notification.params); }
    catch (cause) { reject(new Error("codex_tui_settings_confirmation_invalid", { cause })); return; }
    if (latestObservation && notification.sequence <= latestObservation.sequence) return;
    const actual = parsed.threadSettings;
    latestObservation = {
      sequence: notification.sequence,
      matches: matches(actual),
    };
    if (latestObservation.matches) confirm();
  });
  const removeLifecycle = client.subscribeLifecycle(() => {
    try { assertCurrent(); } catch (error) { reject(error); }
  });
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => reject(new Error(latestObservation
    ? "codex_tui_settings_confirmation_mismatch"
    : "codex_tui_settings_confirmation_missing")), SETTINGS_CONFIRMATION_TIMEOUT_MILLISECONDS);
  timeout.unref?.();
  try {
    assertCurrent();
    const receipt = await client.requestWithReceipt(codexThreadSettingsUpdateMethod, params, {
      timeoutMilliseconds: SETTINGS_CONFIRMATION_TIMEOUT_MILLISECONDS,
      signal,
    });
    if (receipt.generation !== authority.appServerGeneration) {
      throw new Error("codex_tui_settings_generation_changed");
    }
    const readSettings = async () => {
      assertCurrent();
      // The thread is already attached. A resume without overrides returns its
      // current settings, preserving its active turn and existing subscription.
      const current = await client.requestWithReceipt(codexThreadResumeMethod,
        { threadId: authority.backendConversationId, excludeTurns: true }, {
          timeoutMilliseconds: SETTINGS_CONFIRMATION_TIMEOUT_MILLISECONDS, signal,
        });
      assertCurrent();
      if (current.generation !== authority.appServerGeneration ||
          current.result.thread.id !== authority.backendConversationId) {
        throw new Error("codex_tui_settings_generation_changed");
      }
      return { sequence: current.inboundSequence, matches: matches({
        ...current.result, effort: current.result.reasoningEffort,
        sandboxPolicy: current.result.sandbox,
      }) };
    };
    let observed = await readSettings();
    if (!observed.matches) {
      // An accepted update may still be queued. Wait for it to take effect,
      // then read back again; do not launch from an uncorrelated notification.
      await confirmed;
      observed = await readSettings();
    }
    assertCurrent();
    if (confirmationError !== undefined) throw confirmationError;
    if (!observed.matches || (latestObservation &&
        latestObservation.sequence > observed.sequence && !latestObservation.matches)) {
      throw new Error("codex_tui_settings_confirmation_mismatch");
    }
    return modelSelection;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    removeNotification();
    removeLifecycle();
  }
}
