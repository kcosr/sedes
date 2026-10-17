import { WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS } from "../../shared/index.js";

const DOWNLOAD_FRAME_CLEANUP_GRACE_MILLISECONDS = 5 * 60 * 1_000;

/** Attachment navigation preserves browser streaming without buffering the file in JS. */
export function startBrowserDownload(input: {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly className?: string;
  readonly onFailure: (message: string) => void;
  readonly failureMessage: string;
  readonly redirectMessage: string;
  readonly errorMessages?: Readonly<Record<string, string>>;
}): void {
  if (input.signal?.aborted) return;
  const frame = document.createElement("iframe");
  frame.className = input.className ?? "sedes-download-frame";
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  const cleanup = () => {
    window.clearTimeout(cleanupTimer);
    input.signal?.removeEventListener("abort", cleanup);
    frame.remove();
  };
  const cleanupTimer = window.setTimeout(
    cleanup,
    WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS + DOWNLOAD_FRAME_CLEANUP_GRACE_MILLISECONDS,
  );
  input.signal?.addEventListener("abort", cleanup, { once: true });
  frame.addEventListener("load", () => {
    if (input.signal?.aborted) return;
    const failure = browserDownloadFailure(frame, input);
    if (!failure) return;
    cleanup();
    input.onFailure(failure);
  });
  frame.src = input.url;
  document.body.append(frame);
}

function browserDownloadFailure(
  frame: HTMLIFrameElement,
  input: Parameters<typeof startBrowserDownload>[0],
): string | undefined {
  try {
    const loadedUrl = frame.contentWindow?.location.href;
    if (!loadedUrl || loadedUrl === "about:blank") return undefined;
    if (loadedUrl !== new URL(input.url, window.location.href).href)
      return input.redirectMessage;
    const body = frame.contentDocument?.body?.textContent?.trim();
    if (body) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === "object" && parsed !== null && "error" in parsed &&
            typeof parsed.error === "object" && parsed.error !== null &&
            "message" in parsed.error && typeof parsed.error.message === "string" &&
            parsed.error.message.trim()) {
          const code = "code" in parsed.error ? parsed.error.code : undefined;
          return (typeof code === "string" ? input.errorMessages?.[code] : undefined) ??
            parsed.error.message.trim();
        }
      } catch {
        // Never surface malformed documents as a user-facing error.
      }
    }
  } catch {
    // A response frame policy can hide even a same-origin error document.
  }
  return input.failureMessage;
}
