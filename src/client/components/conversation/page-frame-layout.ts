import type { PageViewport } from "../../../shared/protocol/pages.js";

/** Layout pixels inside the document are independent of its display scale. */
export function pageFrameLayout(
  viewport: PageViewport,
  availableWidth: number,
  measuredHeight: number,
  zoom = 1,
): {
  width: number;
  height: number;
  scale: number;
  displayWidth: number;
  displayHeight: number;
} {
  const width = viewport.width ?? Math.max(100, availableWidth);
  const height = viewport.height ?? Math.max(1, Math.min(8192, measuredHeight));
  const scale = Math.min(1, Math.max(100, availableWidth) / width) * zoom;
  return {
    width,
    height,
    scale,
    displayWidth: width * scale,
    displayHeight: height * scale,
  };
}

export type PageFrameMessage =
  | { readonly kind: "size"; readonly height: number }
  | { readonly kind: "wrapper-ready" }
  | { readonly kind: "error" };

export function pageFrameMessage(
  event: Pick<MessageEvent, "source" | "data">,
  source: Window | null,
  channel: string,
): PageFrameMessage | undefined {
  if (
    !source ||
    event.source !== source ||
    typeof event.data !== "object" ||
    event.data === null
  )
    return;
  const data = event.data as Record<string, unknown>;
  if (data.channel !== channel) return;
  if (data.type === "sedes:page-wrapper-ready") return { kind: "wrapper-ready" };
  if (data.type === "sedes:page-error") return { kind: "error" };
  if (
    data.type !== "sedes:page-size" ||
    typeof data.height !== "number" ||
    !Number.isFinite(data.height)
  )
    return;
  return {
    kind: "size",
    height: Math.max(1, Math.min(8192, Math.ceil(data.height))),
  };
}
