import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  apiErrorSchema,
  type ApiError as ApiErrorBody,
} from "../../shared/protocol/api.js";
import { BackendError } from "../backends/contracts.js";
import { projectRemovalAdmissionError } from "../db/project-removal-errors.js";
import { DomainError } from "../domain/errors.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(
  message = "The requested resource was not found.",
): ApiError {
  return new ApiError(404, "not_found", message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export interface ProjectedApiError {
  readonly status: number;
  readonly body: ApiErrorBody;
}

function bodyParserError(
  error: unknown,
): { readonly status: number; readonly message: string } | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("type" in error) ||
    typeof error.type !== "string"
  ) {
    return undefined;
  }
  if (error.type === "entity.too.large") {
    return {
      status: 413,
      message: "The request body exceeded the allowed size.",
    };
  }
  if (error.type === "entity.parse.failed") {
    return {
      status: 400,
      message: "The request body was not valid JSON.",
    };
  }
  return undefined;
}

export function errorMiddleware(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const projected = projectApiError(error);
  response.status(projected.status).json(projected.body);
}

/**
 * Projects server-private failures into the one bounded browser-safe error
 * vocabulary shared by ordinary JSON requests and thread SSE bootstrap.
 */
export function projectApiError(error: unknown): ProjectedApiError {
  return projectApiErrorAt(error, new Set<object>(), 0);
}

function projectApiErrorAt(
  error: unknown,
  seen: Set<object>,
  depth: number,
): ProjectedApiError {
  error = projectRemovalAdmissionError(error) ?? error;
  if (error instanceof ApiError) {
    return projected(error.status, {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    });
  }
  const parserError = bodyParserError(error);
  if (parserError) {
    return projected(parserError.status, {
      error: {
        code: "bad_request",
        message: parserError.message,
        retryable: false,
      },
    });
  }
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "workspace_missing"
          ? 404
          : error.code === "attachment_quota_exceeded"
            ? 413
            : error.code === "workspace_file_download_too_large"
              ? 413
              : error.code === "runtime_unavailable"
                ? 503
                : error.code.endsWith("conflict") ||
                    error.code === "cursor_invalid" ||
                    error.code === "materialization_unresolved" ||
                    error.code === "task_reference_unresolved" ||
                    error.code === "task_context_too_large" ||
                    error.code === "workspace_file_write_outcome_unknown" ||
                    error.code === "operation_outcome_uncertain"
                  ? 409
                  : 400;
    return projected(status, {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    });
  }
  if (error instanceof BackendError) {
    const status =
      error.category === "not_found"
        ? 404
        : error.category === "permission_denied"
          ? 403
          : error.category === "unavailable" || error.category === "overloaded"
            ? 503
            : error.category === "submission_unknown"
              ? 409
              : error.category === "invalid_state" ||
                  error.category === "rejected" ||
                  error.category === "incompatible_protocol"
                ? 409
                : 500;
    return projected(status, {
      error: {
        code: `backend_${error.category}`,
        message: error.safeMessage,
        retryable: error.retryable,
      },
    });
  }
  if (error instanceof ZodError) {
    return projected(400, {
      error: {
        code: "bad_request",
        message: "The request did not match the expected contract.",
        retryable: false,
      },
    });
  }
  if (error instanceof AggregateError && error.cause !== undefined) {
    if (depth >= 8 || seen.has(error)) {
      return internalErrorProjection();
    }
    seen.add(error);
    return projectApiErrorAt(error.cause, seen, depth + 1);
  }
  return internalErrorProjection();
}

function internalErrorProjection(): ProjectedApiError {
  return projected(500, {
    error: {
      code: "internal_error",
      message: "The request could not be completed.",
      retryable: false,
    },
  });
}

function projected(status: number, body: unknown): ProjectedApiError {
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) return { status, body: parsed.data };
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
        retryable: false,
      },
    },
  };
}
