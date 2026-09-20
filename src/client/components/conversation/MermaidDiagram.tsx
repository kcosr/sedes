import { Maximize2 } from "lucide-react";
import { useEffect, useState, type HTMLAttributes } from "react";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../../app/appearance.js";
import { ZoomablePreview } from "../preview/ZoomablePreview.js";
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
      <div
        {...sourcePositionAttributes}
        aria-label="Mermaid diagram could not be rendered"
        className="mermaid-diagram mermaid-diagram-error"
        role="group"
      >
        <p role="alert">Could not render this Mermaid diagram.</p>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div {...sourcePositionAttributes} className="mermaid-diagram">
      {current.status === "rendered" ? (
        <Dialog>
          <DialogTrigger asChild>
            <button
              aria-label="Expand Mermaid diagram"
              className="mermaid-diagram-visual mermaid-diagram-preview-trigger"
              title="Expand diagram"
              type="button"
            >
              <span aria-label="Mermaid diagram" role="img">
                <span
                  aria-hidden="true"
                  className="mermaid-diagram-svg"
                  dangerouslySetInnerHTML={{ __html: current.svg }}
                />
              </span>
              <span aria-hidden="true" className="mermaid-diagram-expand">
                <Maximize2 />
              </span>
            </button>
          </DialogTrigger>
          <DialogContent className="mermaid-diagram-dialog">
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
    </div>
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
