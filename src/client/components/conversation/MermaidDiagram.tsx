import { Maximize2 } from "lucide-react";
import { useEffect, useState, type HTMLAttributes } from "react";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../../app/appearance.js";
import { ZoomablePreview } from "../preview/ZoomablePreview.js";
import { Button } from "../ui/button.js";
import { MediaFrame } from "../../workbench/components/MediaFrame.js";
import "../../workbench/styles/media-frame.css";
import "./page-preview.css";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";
import { renderMermaid, type MermaidAppearance } from "./mermaid-renderer.js";

type DiagramState =
  | { readonly key: string; readonly status: "loading" }
  | { readonly key: string; readonly status: "rendered"; readonly svg: string }
  | { readonly key: string; readonly status: "error" };

export function MermaidDiagram({
  source,
  sourcePositionAttributes,
}: {
  readonly source: string;
  readonly sourcePositionAttributes: HTMLAttributes<HTMLDivElement>;
}): React.JSX.Element {
  const [appearance, setAppearance] = useState<MermaidAppearance>(
    getResolvedAppearance,
  );
  const key = `${appearance}\u0000${source}`;
  const [state, setState] = useState<DiagramState>({
    key,
    status: "loading",
  });

  useEffect(
    () =>
      subscribeResolvedAppearance((nextAppearance) => {
        setAppearance(nextAppearance);
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    setState({ key, status: "loading" });
    void renderMermaid(source, appearance).then(
      (svg) => {
        if (active) setState({ key, status: "rendered", svg });
      },
      () => {
        if (active) setState({ key, status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [appearance, key, source]);

  const current =
    state.key === key ? state : { key, status: "loading" as const };
  if (current.status === "error") {
    return (
      <MediaFrame
        {...sourcePositionAttributes}
        aria-label="Mermaid diagram could not be rendered"
        className="mermaid-diagram mermaid-diagram-error conversation-media-frame"
        role="group"
      >
        <p role="alert">Could not render this Mermaid diagram.</p>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </MediaFrame>
    );
  }

  return (
    <MediaFrame
      {...sourcePositionAttributes}
      className="mermaid-diagram conversation-media-frame"
    >
      {current.status === "rendered" ? (
        <Dialog>
          <div className="inline-media-preview">
            <ZoomablePreview
              controlsLabel="Diagram zoom controls"
              interactionMode="inline"
              resetLabel="Reset diagram view"
              title="Mermaid diagram"
              viewportLabel="Inline Mermaid diagram preview"
            >
              <span
                aria-label="Mermaid diagram"
                role="img"
                className="mermaid-diagram-svg"
                dangerouslySetInnerHTML={{ __html: current.svg }}
              />
            </ZoomablePreview>
            <DialogTrigger asChild>
              <Button
                aria-label="Expand Mermaid diagram"
                className="inline-media-expand"
                size="icon-xs"
                variant="outline"
                title="Expand diagram"
              >
                <Maximize2 />
              </Button>
            </DialogTrigger>
          </div>
          <DialogContent size="viewer" className="media-preview-dialog" aria-describedby={undefined}>
            <DialogTitle className="sr-only">
              Mermaid diagram preview
            </DialogTitle>
            <ZoomablePreview
              controlsLabel="Diagram zoom controls"
              interactionMode="popup"
              resetLabel="Reset diagram view"
              title="Mermaid diagram"
              viewportLabel="Mermaid diagram preview"
            >
              <MermaidPreviewImage svg={current.svg} />
            </ZoomablePreview>
          </DialogContent>
        </Dialog>
      ) : (
        <span className="mermaid-diagram-status" role="status">
          Rendering diagram…
        </span>
      )}
    </MediaFrame>
  );
}

function MermaidPreviewImage({
  svg,
}: {
  readonly svg: string;
}): React.JSX.Element {
  const [source, setSource] = useState<string>();

  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml" }),
    );
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [svg]);

  return source ? (
    <img alt="" draggable={false} src={source} />
  ) : (
    <span className="mermaid-diagram-status" role="status">
      Preparing diagram…
    </span>
  );
}
