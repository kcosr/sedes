import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize2 } from "lucide-react";
import type {
  CollaborationItem,
  CompactionItem,
  ImageItem,
  NoticeItem,
  PlanItem,
  ReviewMarkerItem,
} from "../../../../shared/index.js";
import { ZoomablePreview } from "../../preview/ZoomablePreview.js";
import { canSafelyPreviewRaster } from "../../../attachments/safeRasterPreview.js";
import {
  presentAndroidOutputImageActions,
  supportsAndroidOutputImageActions,
} from "../../../app/android-output-image-actions.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../../ui/dialog.js";
import { MarkdownContent } from "../MarkdownContent";
import type { ConversationItemRenderer } from "../types";

export const planRenderer: ConversationItemRenderer<PlanItem> = {
  kind: "plan",
  render(item) {
    return (
      <section className="plan-block" aria-label="Plan">
        <ol className="plan-list">
          {item.entries.map((entry) => (
            <li data-plan-status={entry.status} key={entry.id}>
              <span aria-hidden="true" className="plan-dot" />
              <span className="plan-text">{entry.text.text}</span>
              <span className="plan-status">
                {entry.status.replaceAll("_", " ")}
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  },
};

export const collaborationRenderer: ConversationItemRenderer<CollaborationItem> =
  {
    kind: "collaboration",
    render(item) {
      const summary = item.summary?.text.trim();
      const label =
        summary || `${item.agentLabel?.text ?? "Subagent"} · ${item.action}`;
      return (
        <section
          className="collab-row marker-label"
          aria-label="Collaboration activity"
        >
          <span aria-hidden="true" className="marker-dot info" />
          <span className="collab-summary">{label}</span>
        </section>
      );
    },
  };

export const imageRenderer: ConversationItemRenderer<ImageItem> = {
  kind: "image",
  render(item, context) {
    const image = item.image;
    const caption =
      image.alt?.text ??
      (image.representation === "artifact" ? image.fileName?.text : undefined);
    return (
      <figure className="image-figure">
        {image.representation === "artifact" ? (
          <ArtifactImage
            key={image.artifactId}
            artifact={image}
            loadContent={context.loadOutputArtifactContent}
          />
        ) : (
          <div className="marker-label">
            <span aria-hidden="true" className="marker-dot" />
            Image unavailable · {image.reason.replaceAll("_", " ")}
          </div>
        )}
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  },
};

type ArtifactImageReference = Extract<
  ImageItem["image"],
  { readonly representation: "artifact" }
>;

function ArtifactImage({
  artifact,
  loadContent,
}: {
  readonly artifact: ArtifactImageReference;
  readonly loadContent?: (
    artifactId: string,
    signal: AbortSignal,
  ) => Promise<Blob>;
}): React.JSX.Element {
  const [loadAdmitted, setLoadAdmitted] = useState(false);
  const [state, setState] = useState<
    | { readonly status: "deferred" }
    | { readonly status: "loading" }
    | {
        readonly status: "ready";
        readonly source: string;
        readonly content: Blob;
      }
    | { readonly status: "error" }
  >({ status: "deferred" });
  const visibilityTarget = useRef<HTMLDivElement | null>(null);
  const objectUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (loadAdmitted) return;
    const target = visibilityTarget.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      // Older embedded browsers without IntersectionObserver retain the
      // functional eager-loading path rather than leaving images inaccessible.
      setLoadAdmitted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setLoadAdmitted(true);
        observer.disconnect();
      },
      { rootMargin: "256px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadAdmitted]);

  useEffect(() => {
    if (!loadAdmitted) return;
    const controller = new AbortController();
    let disposed = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        if (!loadContent) throw new Error("output_artifact_loader_unavailable");
        const content = await loadContent(
          artifact.artifactId,
          controller.signal,
        );
        if (
          disposed ||
          controller.signal.aborted ||
          content.size !== artifact.byteSize ||
          content.type !== artifact.mimeType ||
          !(await canSafelyPreviewRaster(content, artifact.mimeType))
        ) {
          throw new Error("output_artifact_content_invalid");
        }
        if (disposed || controller.signal.aborted) return;
        const source = URL.createObjectURL(content);
        objectUrl.current = source;
        setState({ status: "ready", source, content });
      } catch {
        if (!disposed && !controller.signal.aborted) {
          setState({ status: "error" });
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
    };
  }, [
    artifact.artifactId,
    artifact.byteSize,
    artifact.mimeType,
    loadAdmitted,
    loadContent,
  ]);

  if (state.status === "deferred") {
    return (
      <div className="marker-label" ref={visibilityTarget}>
        <button type="button" onClick={() => setLoadAdmitted(true)}>
          Load image preview
        </button>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="marker-label" role="status">
        Loading image…
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="marker-label">Image unavailable · load failed</div>;
  }
  return (
    <ExpandableImage
      alt={artifact.alt?.text ?? artifact.fileName?.text}
      artifact={artifact}
      content={state.content}
      source={state.source}
      onError={(failedSource) => {
        if (objectUrl.current !== failedSource) return;
        URL.revokeObjectURL(failedSource);
        objectUrl.current = undefined;
        setState({ status: "error" });
      }}
    />
  );
}

function ExpandableImage({
  alt,
  artifact,
  content,
  onError,
  source,
}: {
  readonly alt?: string;
  readonly artifact: ArtifactImageReference;
  readonly content: Blob;
  readonly onError?: (failedSource: string) => void;
  readonly source: string;
}): React.JSX.Element {
  const previewLabel = alt ? `Image preview: ${alt}` : "Image preview";
  const androidActions = supportsAndroidOutputImageActions();
  const actionInFlight = useRef(false);
  const presentActions = useCallback(() => {
    if (!androidActions || actionInFlight.current) return;
    actionInFlight.current = true;
    void presentAndroidOutputImageActions({ artifact, content })
      .catch(() => undefined)
      .finally(() => {
        actionInFlight.current = false;
      });
  }, [androidActions, artifact, content]);
  const longPress = useAndroidLongPress(androidActions, presentActions);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          aria-label={alt ? `Expand image: ${alt}` : "Expand image"}
          className="image-figure-preview"
          data-android-image-actions={androidActions ? "available" : undefined}
          onClickCapture={longPress.onClickCapture}
          onContextMenu={longPress.onContextMenu}
          onPointerCancel={longPress.onPointerCancel}
          onPointerDown={longPress.onPointerDown}
          onPointerMove={longPress.onPointerMove}
          onPointerUp={longPress.onPointerUp}
          title="Expand image"
          type="button"
        >
          <img alt={alt ?? ""} src={source} onError={() => onError?.(source)} />
          <span aria-hidden="true" className="image-figure-expand">
            <Maximize2 />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="attachment-image-dialog sm:max-w-4xl">
        <DialogTitle className="sr-only">{previewLabel}</DialogTitle>
        <ZoomablePreview
          controlsLabel="Image zoom controls"
          interactionMode="popup"
          resetLabel="Reset image view"
          title={alt ?? "Image"}
          viewportLabel={previewLabel}
        >
          <img
            alt=""
            data-android-image-actions={
              androidActions ? "available" : undefined
            }
            draggable={false}
            onClickCapture={longPress.onClickCapture}
            onContextMenu={longPress.onContextMenu}
            onPointerCancel={longPress.onPointerCancel}
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            src={source}
          />
        </ZoomablePreview>
      </DialogContent>
    </Dialog>
  );
}

const ANDROID_IMAGE_LONG_PRESS_MILLISECONDS = 550;
const ANDROID_IMAGE_LONG_PRESS_MOVE_TOLERANCE = 12;

function useAndroidLongPress(
  enabled: boolean,
  onLongPress: () => void,
): {
  readonly onClickCapture: (event: React.MouseEvent) => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
  readonly onPointerCancel: () => void;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onPointerMove: (event: ReactPointerEvent) => void;
  readonly onPointerUp: () => void;
} {
  const timeout = useRef<number | undefined>(undefined);
  const origin = useRef<{ readonly x: number; readonly y: number } | undefined>(
    undefined,
  );
  const suppressClick = useRef(false);

  const clear = useCallback(() => {
    if (timeout.current !== undefined) window.clearTimeout(timeout.current);
    timeout.current = undefined;
    origin.current = undefined;
  }, []);

  useEffect(() => clear, [clear]);

  const trigger = useCallback(() => {
    if (!enabled) return;
    clear();
    suppressClick.current = true;
    onLongPress();
  }, [clear, enabled, onLongPress]);

  return {
    onClickCapture(event) {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event) {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (suppressClick.current) return;
      trigger();
    },
    onPointerCancel: clear,
    onPointerDown(event) {
      if (
        !enabled ||
        event.isPrimary === false ||
        (event.pointerType !== "touch" && event.pointerType !== "pen")
      ) {
        return;
      }
      clear();
      suppressClick.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timeout.current = window.setTimeout(
        trigger,
        ANDROID_IMAGE_LONG_PRESS_MILLISECONDS,
      );
    },
    onPointerMove(event) {
      const start = origin.current;
      if (
        !start ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) <=
          ANDROID_IMAGE_LONG_PRESS_MOVE_TOLERANCE
      ) {
        return;
      }
      clear();
    },
    onPointerUp: clear,
  };
}

export const reviewMarkerRenderer: ConversationItemRenderer<ReviewMarkerItem> =
  {
    kind: "review_marker",
    render(item) {
      return (
        <aside
          aria-label="Review annotation"
          className="review-marker"
          data-verdict={item.verdict}
        >
          <div className="marker-label">
            <span aria-hidden="true" className="marker-dot" />
            <strong>{item.label.text}</strong>
            {item.path && (
              <span className="marker-path">
                {item.path.text}
                {item.range &&
                  ` · lines ${item.range.startLine}–${item.range.endLine}`}
              </span>
            )}
          </div>
          {item.body && <MarkdownContent>{item.body.text}</MarkdownContent>}
        </aside>
      );
    },
  };

export const compactionRenderer: ConversationItemRenderer<CompactionItem> = {
  kind: "compaction",
  render(item) {
    return (
      <aside className="system-marker" aria-label="Conversation compacted">
        <span />
        {item.summary ? (
          <details>
            <summary>Conversation compacted</summary>
            <MarkdownContent>{item.summary.text}</MarkdownContent>
          </details>
        ) : (
          <div>Conversation compacted</div>
        )}
        <span />
      </aside>
    );
  },
};

export const noticeRenderer: ConversationItemRenderer<NoticeItem> = {
  kind: "notice",
  render(item) {
    return (
      <div
        className={`notice ${item.tone}`}
        role={item.tone === "error" ? "alert" : "status"}
      >
        {item.text.text}
      </div>
    );
  },
};
