import type { BoundedValue, ProviderFeatureStateEnvelope } from "../../shared/index.js";
import type { ClientProviderFeatureModule } from "./registry.js";
import { SlidersHorizontal } from "lucide-react";
import { menuDescriptionClass } from "@client/components/ui/floating";
import { cn } from "@client/lib/utils";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuValue, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger } from "@client/components/ui/dropdown-menu";

const ref = { featureId: "antigravity.mode", schemaVersion: 1 } as const;
const options = [
  { value: "__native__", action: "keep_native_mode", label: "Keep native mode" },
  { value: "default", action: "set_mode_default", label: "Default" },
  { value: "accept-edits", action: "set_mode_accept_edits", label: "Accept edits" },
  { value: "auto", action: "set_mode_auto", label: "Auto" },
  { value: "plan", action: "set_mode_plan", label: "Plan" },
] as const;

export const antigravityModeClientFeature: ClientProviderFeatureModule = {
  ref, renderThreadDetails: input => <AntigravityModeControls {...input} />,
};
function AntigravityModeControls({ store, capability, featureState, disabled }:
  Parameters<ClientProviderFeatureModule["renderThreadDetails"]>[0]): React.JSX.Element {
  const state = decode(featureState);
  if (!state || !featureState) return <></>;
  const selection = options.find(option => state.desiredMode === null
    ? option.action === "keep_native_mode" : option.action !== "keep_native_mode" && option.value === state.desiredMode);
  const selected = selection?.action ?? "unavailable_native_mode";
  const available = (actionId: string) => capability.availability === "available" &&
    capability.operations.some(operation => operation.actionId === actionId);
  const valueId = `antigravity-mode-${featureState.revision}`;
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger aria-describedby={valueId}>
      <SlidersHorizontal aria-hidden="true" />Antigravity mode
      <DropdownMenuValue id={valueId} aria-hidden="true">{selection?.label ?? state.desiredMode}</DropdownMenuValue>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent>
      <p className={cn(menuDescriptionClass, "m-0 px-2 py-1.5")}>
        Applies before the next turn. Keep native mode preserves Antigravity’s current choice.
      </p>
      {(disabled || capability.availability !== "available") && <p role="status" className={cn(menuDescriptionClass, "m-0 px-2 py-1.5")}>
        {capability.unavailableReason?.text ?? "Can't be changed right now"}
      </p>}
      <DropdownMenuRadioGroup aria-label="Antigravity mode" value={selected} onValueChange={next => {
        const option = options.find(value => value.action === next);
        if (disabled || !option || next === selected || !available(option.action)) return;
        void store.perform({ action: "perform_provider_feature", feature: ref, actionId: option.action,
          arguments: null, expectedMutationRevision: capability.mutationRevision }).catch(() => undefined);
      }}>
        {options.map(option => <DropdownMenuRadioItem key={option.action} value={option.action} disabled={disabled || !available(option.action)}>
          {option.label}
          {!available(option.action) && selected === option.action && <DropdownMenuValue aria-hidden="true">Unavailable</DropdownMenuValue>}
        </DropdownMenuRadioItem>)}
        {!selection && <DropdownMenuRadioItem value={selected} disabled>{state.desiredMode}<DropdownMenuValue aria-hidden="true">Unavailable</DropdownMenuValue></DropdownMenuRadioItem>}
      </DropdownMenuRadioGroup>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}
function decode(envelope: ProviderFeatureStateEnvelope | undefined): { desiredMode: string | null } | undefined {
  if (!envelope || envelope.ref.featureId !== ref.featureId || envelope.ref.schemaVersion !== ref.schemaVersion ||
      !envelope.state || typeof envelope.state !== "object" || !("kind" in envelope.state) || envelope.state.kind !== "object") return undefined;
  if (envelope.state.entries.length !== 2) return undefined;
  const entries: Record<string, BoundedValue> = Object.fromEntries(envelope.state.entries.map(entry => [entry.key.text, entry.value]));
  if (Object.keys(entries).sort().join(",") !== "application,desiredMode" || text(entries.application) !== "next_turn") return undefined;
  const desiredMode = entries.desiredMode === null ? null : text(entries.desiredMode);
  if (desiredMode === undefined || desiredMode !== null && (desiredMode.length === 0 || desiredMode.length > 120)) return undefined;
  return { desiredMode };
}
function text(value: BoundedValue | undefined): string | undefined {
  return value && typeof value === "object" && "text" in value ? value.text : undefined;
}
