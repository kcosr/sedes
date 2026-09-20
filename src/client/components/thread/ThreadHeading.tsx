import { Box, Folder } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type {
  BackendPresentation,
  NormalizedEnvironmentSummary,
} from "../../../shared/index.js";
import {
  environmentTintStyle,
  resolveEnvironmentPaletteTones,
  type EnvironmentTintStyle,
} from "../../app/environment-palette.js";
import { useEnvironmentColorsEnabled } from "../../app/use-environment-colors-enabled.js";
import { useEnvironmentPalette } from "../../app/use-environment-palette.js";
import { BackendBrandIcon } from "../brand-icons.js";

/** Thread identity presentation shared by loading and connected headers. */
export function ThreadHeading({
  backend,
  title,
  status,
  context,
  worktree,
  mobile,
}: {
  readonly backend?: Pick<BackendPresentation, "label" | "brand">;
  readonly title: ReactNode;
  readonly status?: ReactNode;
  readonly context?: {
    readonly projectLabel: string;
    readonly targetLabel?: string;
    readonly targetAvailable?: boolean;
  };
  readonly worktree?: ReactNode;
  readonly mobile: boolean;
}): React.JSX.Element {
  return (
    <>
      {backend?.brand !== undefined && (
        <span className="thread-panel-brand" title={backend.label.text}>
          <BackendBrandIcon brand={backend.brand} size={24} />
        </span>
      )}
      <div className="thread-heading" data-testid="thread-heading">
        <div className="thread-title-row">
          {title}
          {status}
        </div>
        {context && (
          <span
            className="thread-project thread-location-context"
            data-testid="thread-context"
            title={
              mobile || !context.targetLabel
                ? context.projectLabel
                : `${context.projectLabel} · ${context.targetLabel}`
            }
          >
            <Folder size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="thread-project-name">{context.projectLabel}</span>
            {!mobile && context.targetLabel && (
              <span
                className="thread-location-target"
                data-testid="thread-target-context"
              >
                <Box size={13} strokeWidth={1.8} aria-hidden="true" />
                {context.targetLabel}
                {context.targetAvailable === false ? " · Unavailable" : ""}
              </span>
            )}
            {!mobile && worktree}
          </span>
        )}
      </div>
    </>
  );
}

export function useThreadHeaderTint(
  environments: readonly NormalizedEnvironmentSummary[],
  environmentId?: string,
): EnvironmentTintStyle | undefined {
  const palette = useEnvironmentPalette();
  const colorsEnabled = useEnvironmentColorsEnabled();
  const tones = useMemo(
    () =>
      resolveEnvironmentPaletteTones(environments.map(({ id }) => id), palette),
    [environments, palette],
  );
  const tone = environmentId === undefined ? undefined : tones.get(environmentId);
  return colorsEnabled && environments.length > 1 && tone
    ? environmentTintStyle(tone)
    : undefined;
}
