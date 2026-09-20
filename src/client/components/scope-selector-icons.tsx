import { Monitor, Server } from "lucide-react";
import type { BackendBrand } from "../../shared/index.js";
import { BackendBrandIcon } from "./brand-icons.js";

export function EnvironmentScopeIcon({
  kind,
  size = 14,
}: {
  readonly kind: "local" | "ssh" | "outbound";
  readonly size?: number;
}): React.JSX.Element {
  const Icon = kind === "local" ? Monitor : Server;
  return <Icon size={size} strokeWidth={1.8} data-environment-kind={kind} />;
}

export function TargetScopeIcon({
  brand,
  size = 14,
}: {
  readonly brand: BackendBrand;
  readonly size?: number;
}): React.JSX.Element {
  return (
    <BackendBrandIcon brand={brand} size={size} data-backend-brand={brand} />
  );
}
