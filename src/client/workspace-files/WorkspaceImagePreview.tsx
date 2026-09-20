import {
  ZoomablePreview,
  type ZoomablePreviewInteractionMode,
  type ZoomableViewState,
} from "../components/preview/ZoomablePreview.js";

export type WorkspaceImageViewState = ZoomableViewState;

export function WorkspaceImagePreview({
  initialViewState,
  interactionMode,
  onViewStateChange,
  path,
  source,
  toolbarActions,
}: {
  readonly initialViewState?: WorkspaceImageViewState;
  readonly interactionMode?: ZoomablePreviewInteractionMode;
  readonly onViewStateChange?: (state: WorkspaceImageViewState) => void;
  readonly path: string;
  readonly source: string;
  readonly toolbarActions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <ZoomablePreview
      controlsLabel="Image zoom controls"
      initialViewState={initialViewState}
      interactionMode={interactionMode}
      onViewStateChange={onViewStateChange}
      resetLabel="Reset image view"
      toolbarActions={toolbarActions}
      title={path}
      viewportLabel={`Image preview for ${path}`}
    >
      <img alt={path} draggable={false} src={source} />
    </ZoomablePreview>
  );
}
