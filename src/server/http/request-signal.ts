import type { Request, Response } from "express";

/** Aborts when the HTTP client disconnects before the response completes. */
export function workspaceFileRequestSignal(
  request: Request,
  response: Response,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("workspace_file_http_request_closed"));
    }
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return controller.signal;
}
