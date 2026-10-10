import { PanelTop } from "lucide-react";
import { PaneResizeHandle } from "../components/PaneResizeHandle.js";
import { PANEL_TITLES } from "./panel-kinds.js";
import type {
  RegionBox,
  RegionGeometry,
  RegionResizeHandle,
  RegionStage as RegionStageSize,
} from "./region-geometry.js";
import type { PanelKind, RegionId } from "./regions.js";

/**
 * The desktop stage: each visible panel in its region's box, and a divider
 * on each edge region's inner side. Panels are siblings keyed by kind and
 * placed by position, so moving a panel to another region, maximizing it or
 * showing another beside it never remounts it. Boxes are shares of the
 * stage, so the layout keeps its proportions until the next measurement.
 */
export function RegionStage({
  geometry,
  renderPanel,
  onResizePreview,
  onResizeCommit,
  resetSize,
}: {
  readonly geometry: RegionGeometry;
  readonly renderPanel: (kind: PanelKind, region: RegionId) => React.ReactNode;
  readonly onResizePreview: (handle: RegionResizeHandle, size: number) => void;
  readonly onResizeCommit: (handle: RegionResizeHandle, size: number) => void;
  /** A divider's double-click size: the panel's default. */
  readonly resetSize: (handle: RegionResizeHandle) => number;
}): React.JSX.Element {
  if (geometry.panels.length === 0) return <EmptyWorkbench />;
  return (
    <>
      {geometry.panels.map(({ kind, region, box }) => (
        <div
          key={kind}
          className="workspace-region"
          data-region={region}
          data-region-kind={kind}
          style={boxStyle(box, geometry.stage)}
        >
          {renderPanel(kind, region)}
        </div>
      ))}
      {geometry.handles.map((handle) => (
        <div
          key={handle.region}
          className="workspace-region-divider"
          data-region={handle.region}
          data-axis={handle.axis}
          style={boxStyle(handle.box, geometry.stage)}
        >
          <PaneResizeHandle
            orientation={handle.axis === "width" ? "row" : "column"}
            value={handle.size}
            min={handle.min}
            max={handle.max}
            resetValue={resetSize(handle)}
            // A divider on a region's left or top side grows it moving back.
            reverse={handle.region === "right" || handle.region === "bottom"}
            ariaLabel={`Resize ${PANEL_TITLES[handle.kind]} panel`}
            className="workspace-panel-resize-handle"
            testId="workspace-panel-resize-handle"
            onPreview={(value) => onResizePreview(handle, value)}
            onCommit={(value) => onResizeCommit(handle, value)}
          />
        </div>
      ))}
    </>
  );
}

function boxStyle(box: RegionBox, stage: RegionStageSize): React.CSSProperties {
  const share = (value: number, length: number) =>
    length > 0 ? `${(value / length) * 100}%` : "0";
  return {
    left: share(box.x, stage.width),
    top: share(box.y, stage.height),
    width: share(box.width, stage.width),
    height: share(box.height, stage.height),
  };
}

export function EmptyWorkbench(): React.JSX.Element {
  return (
    <section className="workspace-panel-empty" data-testid="workspace-panel-empty">
      <PanelTop className="workspace-panel-empty-icon" aria-hidden size={28} />
      <h2>No panels are shown</h2>
      <p>Show a panel from the panels menu or its button in the bar.</p>
    </section>
  );
}
