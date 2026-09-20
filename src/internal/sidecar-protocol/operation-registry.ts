import { z } from "zod";

export interface SidecarOperationKey {
  readonly capabilityId: string;
  readonly majorVersion: number;
  readonly operation: string;
}

export interface SidecarOperationDefinition<
  Request,
  Response,
> extends SidecarOperationKey {
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
  readonly maximumDeadlineMilliseconds: number | "caller_abort";
  readonly lane: "control" | "operation";
}

export interface SidecarOperationContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type SidecarOperationHandler<Request, Response> = (
  request: Request,
  context: SidecarOperationContext,
) => Promise<Response> | Response;

export interface RegisteredSidecarOperation {
  readonly definition: SidecarOperationDefinition<unknown, unknown>;
  readonly handler: SidecarOperationHandler<unknown, unknown>;
}

export class SidecarOperationRegistry {
  readonly #operations = new Map<string, RegisteredSidecarOperation>();
  readonly #beforeDispatch: (() => void) | undefined;

  constructor(input?: { readonly beforeDispatch?: () => void }) { this.#beforeDispatch = input?.beforeDispatch; }

  /** Each attachment adds its own framed streams to an immutable handler base. */
  fork(): SidecarOperationRegistry {
    const registry = new SidecarOperationRegistry();
    for (const operation of this.#operations.values()) registry.register(operation.definition, operation.handler);
    return registry;
  }

  register<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    handler: SidecarOperationHandler<Request, Response>,
  ): void {
    validateDefinition(definition);
    const key = operationKey(definition);
    if (this.#operations.has(key)) {
      throw new Error("sidecar_operation_already_registered");
    }
    this.#operations.set(key, {
      definition: definition as SidecarOperationDefinition<unknown, unknown>,
      handler: ((request, context) => {
        this.#beforeDispatch?.();
        return handler(request as Request, context);
      }) as SidecarOperationHandler<unknown, unknown>,
    });
  }

  resolve(key: SidecarOperationKey): RegisteredSidecarOperation | undefined {
    return this.#operations.get(operationKey(key));
  }

  capabilities(): readonly {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly operations: readonly string[];
  }[] {
    const grouped = new Map<string, Set<string>>();
    for (const operation of this.#operations.values()) {
      const { capabilityId, majorVersion } = operation.definition;
      const key = `${capabilityId}\0${majorVersion}`;
      let values = grouped.get(key);
      if (!values) {
        values = new Set();
        grouped.set(key, values);
      }
      values.add(operation.definition.operation);
    }
    return [...grouped.entries()]
      .map(([key, operations]) => {
        const [capabilityId, major] = key.split("\0");
        return Object.freeze({
          capabilityId: capabilityId!,
          majorVersion: Number(major),
          operations: Object.freeze([...operations].sort()),
        });
      })
      .sort((left, right) =>
        left.capabilityId === right.capabilityId
          ? left.majorVersion - right.majorVersion
          : left.capabilityId.localeCompare(right.capabilityId),
      );
  }
}

export class SidecarOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false, options?: ErrorOptions) {
    super(code, options);
    if (!/^[a-z][a-z0-9_.-]{0,119}$/u.test(code)) {
      throw new Error("sidecar_operation_error_code_invalid");
    }
    this.name = "SidecarOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function operationKey(key: SidecarOperationKey): string {
  return `${key.capabilityId}\0${key.majorVersion}\0${key.operation}`;
}

function validateDefinition(
  definition: SidecarOperationDefinition<unknown, unknown>,
): void {
  const callerAbortAllowed =
    (definition.capabilityId === "agent_tools_cli" &&
      definition.majorVersion === 3 &&
      definition.operation === "tool.invoke" &&
      definition.lane === "operation") ||
    (definition.capabilityId === "claude_runtime" &&
      definition.majorVersion === 1 &&
      [
        "query.can_use_tool",
        "query.open",
        "runtime.initialize",
        "runtime.probe",
      ].includes(definition.operation));
  if (
    !/^[a-z][a-z0-9_.-]{0,119}$/u.test(definition.capabilityId) ||
    !/^[a-z][a-z0-9_.-]{0,119}$/u.test(definition.operation) ||
    !Number.isSafeInteger(definition.majorVersion) ||
    definition.majorVersion <= 0 ||
    definition.majorVersion > 65_535 ||
    (definition.maximumDeadlineMilliseconds !== "caller_abort" &&
      (!Number.isSafeInteger(definition.maximumDeadlineMilliseconds) ||
        definition.maximumDeadlineMilliseconds <= 0 ||
        definition.maximumDeadlineMilliseconds > 605_000)) ||
    (definition.maximumDeadlineMilliseconds === "caller_abort" &&
      !callerAbortAllowed)
  ) {
    throw new Error("sidecar_operation_definition_invalid");
  }
}

export function defineSidecarOperation<
  Request,
  Response,
  const Definition extends SidecarOperationDefinition<Request, Response>,
>(definition: Definition): Definition {
  validateDefinition(
    definition as SidecarOperationDefinition<unknown, unknown>,
  );
  return Object.freeze({ ...definition }) as Definition;
}
