import { useEffect, useRef, useState } from "react";
import { Rocket, Zap } from "lucide-react";
import { Tooltip } from "radix-ui";
import { ApiError } from "../api/ApiClient.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItemDescription,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import {
  CODEX_SPEED_REF as ref, speedArgumentsValue, speedResultWireSchema, speedStateWireSchema,
  type SpeedResult, type SpeedSelection, type SpeedState,
} from "../../shared/provider-features/codex-speed.js";
import type { ClientProviderFeatureModule } from "./registry.js";

const LABELS = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" } as const;
const SPEED_TOOLTIP = "Applies from the next model step. Saved for future turns.";
export const codexFastModeClientFeature: ClientProviderFeatureModule = {
  ref,
  renderThreadDetails() { return null; },
  renderComposerAction(input) { return <CodexSpeedComposerControl {...input} />; },
};
type Input = Parameters<NonNullable<ClientProviderFeatureModule["renderComposerAction"]>>[0];

function CodexSpeedComposerControl({ store, capability, featureState, disabled, mobile }: Input) {
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const currentAttempt = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; currentAttempt.current = undefined; setPending(false);
    return () => { mounted.current = false; }; }, [store]);
  const decoded = featureState?.ref.featureId === ref.featureId && featureState.ref.schemaVersion === ref.schemaVersion
    ? speedStateWireSchema.safeParse(featureState.state) : undefined;
  const state = decoded?.success ? decoded.data : undefined;
  const unavailable = disabled || pending || capability.availability !== "available" ||
    !capability.operations.some(operation => operation.actionId === "set_speed");
  useEffect(() => { if (unavailable) setMenuOpen(false); }, [unavailable]);

  const read = async (id: string, poll = 0, previous?: SpeedResult): Promise<void> => {
    let retry = false;
    let latest = previous;
    try {
      const response = await store.readProviderFeatureAttempt(id);
      if (!mounted.current || currentAttempt.current !== id) return;
      if (response.status !== "provider_feature_result" || response.operationId !== id ||
          response.feature.featureId !== ref.featureId || response.feature.schemaVersion !== ref.schemaVersion) {
        throw new Error("The Speed receipt could not be confirmed.");
      }
      const result = speedResultWireSchema.parse(response.result);
      if (result.operationId !== id) throw new Error("The Speed receipt did not match this request.");
      if (previous && (result.receiptRevision < previous.receiptRevision ||
          (result.receiptRevision === previous.receiptRevision && JSON.stringify(result) !== JSON.stringify(previous)))) {
        throw new Error("The Speed receipt changed unexpectedly.");
      }
      latest = result;
      retry = result.currentRun.status === "pending";
      if (!retry) store.discardProviderFeatureAttempt(id);
    } catch (error) {
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.retryable;
      if (rejected) store.discardProviderFeatureAttempt(id);
      retry = !rejected;
    }
    if (!mounted.current || currentAttempt.current !== id) return;
    setPending(false);
    // Recover a lost reply quietly with the exact original envelope. The icon
    // always follows the authoritative saved preference, never this receipt.
    if (retry && poll < 3) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (mounted.current && currentAttempt.current === id) await read(id, poll + 1, latest);
    }
  };
  const choose = (selection: SpeedSelection): void => {
    if (!state || unavailable) return;
    try {
      const id = store.createProviderFeatureAttempt({ action: "perform_provider_feature", feature: ref, actionId: "set_speed",
        arguments: speedArgumentsValue({ selection, currentRunTarget: state.currentRun?.target ?? null }),
        expectedMutationRevision: capability.mutationRevision });
      currentAttempt.current = id;
      setPending(true);
      setMenuOpen(false);
      void read(id);
    } catch {
      // A stale local capability cannot change the authoritative selection.
      setPending(false);
    }
  };
  if (!state) return null;
  const selection = state.saved.selection;
  const accelerated = selection !== "standard";
  const reapply = canReapply(state);
  const tooltip = capability.unavailableReason?.text ?? SPEED_TOOLTIP;
  const acceleratedChoices = state.offered.filter(choice => choice.selection !== "standard");
  const icon = <SpeedIcon selection={selection === "standard" && acceleratedChoices.length === 1 ? acceleratedChoices[0]!.selection : selection} emphasized={accelerated} />;
  const trigger = <button type="button" className="codex-fast-mode-toggle" data-accelerated={accelerated}
    aria-label={`Speed, ${LABELS[selection]} saved`} aria-disabled={unavailable}
    onPointerDown={event => { if (unavailable) event.preventDefault(); }}
    onKeyDown={event => { if (unavailable && event.key !== "Tab") event.preventDefault(); }}
    onClick={event => { if (unavailable) event.preventDefault(); }}>{icon}</button>;
  return <>
    {acceleratedChoices.length === 1 && !state.currentRun?.target ? <SpeedTooltip text={tooltip} disabled={mobile}>
      <button type="button" className="codex-fast-mode-toggle" data-accelerated={accelerated}
        aria-label={`Speed, ${LABELS[selection]} saved`} aria-pressed={accelerated}
        aria-disabled={unavailable}
        onClick={() => { if (!unavailable) choose(accelerated ? "standard" : acceleratedChoices[0]!.selection); }}>{icon}</button>
    </SpeedTooltip> : <DropdownMenu open={menuOpen && !unavailable} onOpenChange={setMenuOpen} presentation={mobile ? "sheet" : "menu"}>
      <SpeedTooltip text={tooltip} disabled={mobile}><DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger></SpeedTooltip>
      <DropdownMenuContent side="top" align="end" aria-label="Speed" sheetTitle="Speed">
        <DropdownMenuRadioGroup aria-label="Speed" value={selection}>
          {state.offered.map(choice => <DropdownMenuRadioItem key={choice.selection} value={choice.selection}
            onSelect={() => { if (choice.selection !== selection || reapply) choose(choice.selection); }}>
            <SpeedIcon selection={choice.selection} emphasized={choice.selection !== "standard"} />
            <span className="min-w-0 flex-1">{LABELS[choice.selection]}
              {choice.description && <DropdownMenuItemDescription>{choice.description}</DropdownMenuItemDescription>}</span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
  </>;
}
function canReapply(state: SpeedState): boolean {
  return !!state.currentRun?.target && (state.currentRun.requestedSelection !== state.saved.selection || state.currentRun.publicationState === "unknown");
}
function SpeedTooltip({ text, children, disabled }: { text: string; children: React.ReactNode; disabled: boolean }) {
  if (disabled) return children;
  return <Tooltip.Provider delayDuration={300}><Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="codex-fast-mode-tooltip" side="top" align="end" sideOffset={6}>
      {text}<Tooltip.Arrow className="codex-fast-mode-tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>;
}
function SpeedIcon({ selection, emphasized }: { selection: SpeedSelection; emphasized: boolean }) {
  return selection === "ultrafast" ? <Rocket className="codex-fast-mode-icon" data-speed-icon="ultrafast" size={15} strokeWidth={1.9} aria-hidden="true" /> :
    <Zap className="codex-fast-mode-icon" data-speed-icon={selection} size={15} strokeWidth={1.9} fill={selection === "fast" && emphasized ? "currentColor" : "none"} aria-hidden="true" />;
}
