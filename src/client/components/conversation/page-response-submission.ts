import { useLayoutEffect, useMemo, useState } from "react";
import { PAGE_RESPONSE_MAX_BYTES, type PageRevision } from "../../../shared/protocol/pages.js";
import { ApiError } from "../../api/ApiClient.js";
import type { PageResponseBridge } from "../../lib/page-response-bridge.js";
import type { PageResponseRequest, PageResponseServices } from "./page-response-services.js";

interface ResponseAttempt {
  inFlight: boolean;
  request?: PageResponseRequest;
}

interface ResponseSession {
  active: boolean;
  attempt?: ResponseAttempt;
}

interface ResponseView {
  phase: "idle" | "sending" | "retry";
  status: string;
  error: string;
}

const idleView: ResponseView = { phase: "idle", status: "", error: "" };

/** One ephemeral submission owner for the inline and expanded frames. Once
 * captured, user input outlives the document that produced it. */
export function usePageResponseSubmission(
  scopeKey: string,
  page: PageRevision,
  services: PageResponseServices | undefined,
): ResponseView & {
  send: (bridge: PageResponseBridge | undefined) => Promise<void>;
  reset: () => void;
} {
  const session = useMemo<ResponseSession>(() => ({ active: false }), [scopeKey]);
  const [view, setView] = useState<ResponseView & { session: ResponseSession }>({ ...idleView, session });

  useLayoutEffect(() => {
    session.active = true;
    return () => {
      // A deliberate scope/selection change or unmount drops only local UI.
      // In particular it must not cancel an already-started admission request.
      session.active = false;
      session.attempt = undefined;
    };
  }, [session]);

  const reset = () => {
    session.attempt = undefined;
    setView({ ...idleView, session });
  };

  const send = async (bridge: PageResponseBridge | undefined) => {
    if (!session.active || !services || services.threadId !== page.threadId || session.attempt?.inFlight) return;
    const previous = session.attempt;
    if (!previous?.request && (!bridge || services.unavailableReason)) return;
    const attempt: ResponseAttempt = previous?.request ? previous : { inFlight: false };
    attempt.inFlight = true;
    session.attempt = attempt;
    const current = () => session.active && session.attempt === attempt;
    const controller = new AbortController();
    setView({ session, phase: "sending", status: "", error: "" });
    let admissionAttempted = false;
    let timeout: number | undefined;
    try {
      let request = attempt.request;
      const retry = request !== undefined;
      if (!request) {
        const text = await bridge!.capture();
        if (!current()) return;
        if (!text.trim()) throw new Error("The page response is empty.");
        if (new TextEncoder().encode(text).byteLength > PAGE_RESPONSE_MAX_BYTES)
          throw new Error("The page response exceeds 64 KiB.");
        request = Object.freeze({
          mutationId: crypto.randomUUID(), text,
          pageResponse: Object.freeze({ pageId: page.pageId, revision: page.revision }),
          runningPolicy: Object.freeze({ mode: "queue" as const }),
        });
        attempt.request = request;
      }
      timeout = window.setTimeout(() => controller.abort(), 15_000);
      const lookup = retry ? await services.readReceipt(request.mutationId, controller.signal) : undefined;
      if (!current()) return;
      let receipt = lookup?.status === "found" ? lookup.receipt : undefined;
      if (!receipt) {
        admissionAttempted = true;
        receipt = await services.submit(request, controller.signal);
      }
      if (!current()) return;
      attempt.request = undefined;
      if (receipt.status === "recovery_required") {
        attempt.request = request;
        setView({ session, phase: "retry", status: "", error: "Delivery is unconfirmed. Use Reconcile in pending inputs before sending again." });
      } else if (receipt.status === "failed" || receipt.status === "cancelled") {
        setView({ session, phase: "idle", status: "", error: receipt.diagnostic ?? "The response was not delivered. Check pending inputs." });
      } else {
        setView({ session, phase: "idle", error: "", status:
          receipt.status === "accepted" ? "Response sent."
            : receipt.currentMode === "queue" ? "Response queued." : "Response submitted.",
        });
      }
    } catch (error) {
      if (!current()) return;
      const rejected = admissionAttempted && error instanceof ApiError &&
        error.status >= 400 && error.status < 500 &&
        error.code !== "operation_outcome_uncertain" && error.code !== "backend_submission_unknown";
      if (rejected) attempt.request = undefined;
      const retry = attempt.request !== undefined;
      setView({ session, phase: retry ? "retry" : "idle", status: "", error: retry
        ? "Delivery could not be confirmed. Retry checks the same response without capturing it again."
        : error instanceof Error ? error.message : "Could not capture the page response.",
      });
    } finally {
      window.clearTimeout(timeout);
      attempt.inFlight = false;
    }
  };

  return { ...(view.session === session ? view : idleView), send, reset };
}

export type PageResponseSubmission = ReturnType<typeof usePageResponseSubmission>;
