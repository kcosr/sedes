import path from "node:path";
import { validEnvironmentChannelScope } from "../../execution/environment-channel.js";
import {
  sameProviderTransportScope,
  type ProviderTransportScope,
} from "../../provider-protocol/transport/assured-framed-transport.js";

export type GrokSessionResidency =
  "provisional_load" | "resident" | "dormant" | "lost";

export interface GrokSessionRoute {
  readonly scope: ProviderTransportScope;
  readonly nativeNamespaceKey: string;
  readonly workspace: string;
  readonly connectionGeneration: number;
  readonly processOwnerId: string;
  readonly sessionId: string;
}

export interface GrokSessionState extends GrokSessionRoute {
  readonly residency: GrokSessionResidency;
}

export interface GrokProvisionalLoadClaim extends GrokSessionRoute {}
export interface GrokProvisionalCreateClaim extends Omit<
  GrokSessionRoute,
  "sessionId"
> {}

type MutableSessionState = Omit<GrokSessionState, "residency"> & {
  residency: GrokSessionResidency;
};

/**
 * Provider-private ownership router. Provider residency is independent from
 * browser viewers and handles; only explicit provider lifecycle transitions
 * mutate this registry.
 */
export class GrokSessionRegistry {
  readonly #sessions = new Map<string, MutableSessionState>();
  readonly #claims = new WeakMap<object, MutableSessionState>();
  readonly #createClaims = new WeakMap<
    object,
    {
      readonly owner: Omit<GrokSessionRoute, "sessionId">;
      readonly key: string;
    }
  >();
  readonly #processRoutes = new Map<string, GrokSessionRoute>();
  readonly #processCreateReservations = new Map<
    string,
    Omit<GrokSessionRoute, "sessionId">
  >();

  beginCreate(
    owner: Omit<GrokSessionRoute, "sessionId">,
  ): GrokProvisionalCreateClaim {
    const probe = validateRoute({ ...owner, sessionId: "process-probe" });
    const key = processOwnerKey(probe);
    if (
      this.#processRoutes.has(key) ||
      this.#processCreateReservations.has(key)
    ) {
      throw new Error("grok_process_session_cardinality_exceeded");
    }
    const validatedOwner = Object.freeze({
      scope: probe.scope,
      nativeNamespaceKey: probe.nativeNamespaceKey,
      workspace: probe.workspace,
      connectionGeneration: probe.connectionGeneration,
      processOwnerId: probe.processOwnerId,
    });
    const claim = Object.freeze({ ...validatedOwner });
    this.#processCreateReservations.set(key, validatedOwner);
    this.#createClaims.set(claim, { owner: validatedOwner, key });
    return claim;
  }

  confirmCreate(
    claim: GrokProvisionalCreateClaim,
    sessionId: string,
  ): GrokProvisionalLoadClaim {
    const reservation = this.#createClaims.get(claim);
    if (
      !reservation ||
      this.#processCreateReservations.get(reservation.key) !== reservation.owner
    ) {
      throw new Error("grok_session_create_claim_invalid");
    }
    const route = validateRoute({ ...reservation.owner, sessionId });
    const key = routeKey(route);
    if (this.#sessions.has(key) || this.#processRoutes.has(reservation.key)) {
      throw new Error("grok_session_create_claim_invalid");
    }
    const state: MutableSessionState = {
      ...route,
      residency: "provisional_load",
    };
    this.#processCreateReservations.delete(reservation.key);
    this.#createClaims.delete(claim);
    this.#processRoutes.set(reservation.key, route);
    this.#sessions.set(key, state);
    const loadClaim = Object.freeze({ ...route });
    this.#claims.set(loadClaim, state);
    return loadClaim;
  }

  cancelCreate(claim: GrokProvisionalCreateClaim): void {
    const reservation = this.#createClaims.get(claim);
    if (
      !reservation ||
      this.#processCreateReservations.get(reservation.key) !== reservation.owner
    ) {
      throw new Error("grok_session_create_claim_invalid");
    }
    this.#processCreateReservations.delete(reservation.key);
    this.#createClaims.delete(claim);
  }

  beginLoad(route: GrokSessionRoute): GrokProvisionalLoadClaim {
    const validated = validateRoute(route);
    const key = routeKey(validated);
    const current = this.#sessions.get(key);
    if (
      current &&
      (!sameProviderTransportScope(current.scope, validated.scope) ||
        current.workspace !== validated.workspace)
    ) {
      throw new Error("grok_session_owner_mismatch");
    }
    if (
      current &&
      (current.residency === "provisional_load" ||
        current.residency === "resident")
    ) {
      throw new Error("grok_session_active_owner_exists");
    }
    if (
      current &&
      validated.connectionGeneration < current.connectionGeneration
    ) {
      throw new Error("grok_session_generation_stale");
    }
    if (
      current?.residency === "lost" &&
      validated.connectionGeneration === current.connectionGeneration
    ) {
      throw new Error("grok_session_generation_stale");
    }
    if (
      current?.residency === "dormant" &&
      validated.connectionGeneration === current.connectionGeneration &&
      !exactOwner(current, validated)
    ) {
      throw new Error("grok_session_owner_mismatch");
    }
    const processKey = processOwnerKey(validated);
    const processRoute = this.#processRoutes.get(processKey);
    if (this.#processCreateReservations.has(processKey)) {
      throw new Error("grok_process_session_cardinality_exceeded");
    }
    if (processRoute !== undefined && !exactOwner(processRoute, validated)) {
      throw new Error("grok_process_session_cardinality_exceeded");
    }
    const state: MutableSessionState = {
      ...validated,
      residency: "provisional_load",
    };
    this.#processRoutes.set(processKey, validated);
    this.#sessions.set(key, state);
    const claim = Object.freeze({ ...validated });
    this.#claims.set(claim, state);
    return claim;
  }

  confirmLoad(claim: GrokProvisionalLoadClaim): GrokSessionState {
    const state = this.#requireClaim(claim);
    state.residency = "resident";
    this.#claims.delete(claim);
    return snapshot(state);
  }

  failLoad(claim: GrokProvisionalLoadClaim): GrokSessionState {
    const state = this.#requireClaim(claim);
    state.residency = "dormant";
    this.#claims.delete(claim);
    return snapshot(state);
  }

  markSessionDormant(route: GrokSessionRoute): GrokSessionState {
    const validated = validateRoute(route);
    const state = this.#sessions.get(routeKey(validated));
    if (
      !state ||
      !exactOwner(state, validated) ||
      (state.residency !== "resident" && state.residency !== "dormant")
    ) {
      throw new Error("grok_session_owner_mismatch");
    }
    state.residency = "dormant";
    return snapshot(state);
  }

  markSessionLost(route: GrokSessionRoute): GrokSessionState {
    const validated = validateRoute(route);
    const state = this.#sessions.get(routeKey(validated));
    if (!state || !exactOwner(state, validated)) {
      throw new Error("grok_session_owner_mismatch");
    }
    state.residency = "lost";
    return snapshot(state);
  }

  requireResident(route: GrokSessionRoute): GrokSessionState {
    return snapshot(this.#requireExactOwner(route, "resident"));
  }

  authorizeNotification(route: GrokSessionRoute): boolean {
    let validated: GrokSessionRoute;
    try {
      validated = validateRoute(route);
    } catch {
      return false;
    }
    const state = this.#sessions.get(routeKey(validated));
    return (
      state !== undefined &&
      (state.residency === "provisional_load" ||
        state.residency === "resident") &&
      exactOwner(state, validated)
    );
  }

  fenceGeneration(input: {
    readonly scope: ProviderTransportScope;
    readonly nativeNamespaceKey: string;
    readonly workspace: string;
    readonly connectionGeneration: number;
    readonly processOwnerId: string;
  }): readonly GrokSessionState[] {
    const probe = validateRoute({ ...input, sessionId: "generation-probe" });
    const fenced: GrokSessionState[] = [];
    for (const state of this.#sessions.values()) {
      if (
        sameProviderTransportScope(state.scope, probe.scope) &&
        state.nativeNamespaceKey === probe.nativeNamespaceKey &&
        state.workspace === probe.workspace &&
        state.connectionGeneration === probe.connectionGeneration &&
        state.processOwnerId === probe.processOwnerId &&
        (state.residency === "provisional_load" ||
          state.residency === "resident" ||
          state.residency === "dormant")
      ) {
        state.residency = "lost";
        fenced.push(snapshot(state));
      }
    }
    return Object.freeze(fenced);
  }

  releaseProcessOwner(input: {
    readonly scope: ProviderTransportScope;
    readonly nativeNamespaceKey: string;
    readonly workspace: string;
    readonly connectionGeneration: number;
    readonly processOwnerId: string;
  }): void {
    const probe = validateRoute({ ...input, sessionId: "release-probe" });
    const key = processOwnerKey(probe);
    const route = this.#processRoutes.get(key);
    if (
      route &&
      route.nativeNamespaceKey === probe.nativeNamespaceKey &&
      route.workspace === probe.workspace &&
      route.connectionGeneration === probe.connectionGeneration &&
      sameProviderTransportScope(route.scope, probe.scope)
    ) {
      this.#processRoutes.delete(key);
    }
    const reservation = this.#processCreateReservations.get(key);
    if (
      reservation &&
      reservation.nativeNamespaceKey === probe.nativeNamespaceKey &&
      reservation.workspace === probe.workspace &&
      reservation.connectionGeneration === probe.connectionGeneration &&
      sameProviderTransportScope(reservation.scope, probe.scope)
    ) {
      this.#processCreateReservations.delete(key);
    }
    for (const [sessionKey, state] of this.#sessions) {
      if (
        sameProviderTransportScope(state.scope, probe.scope) &&
        state.nativeNamespaceKey === probe.nativeNamespaceKey &&
        state.workspace === probe.workspace &&
        state.connectionGeneration === probe.connectionGeneration &&
        state.processOwnerId === probe.processOwnerId
      ) {
        this.#sessions.delete(sessionKey);
      }
    }
  }

  state(route: GrokSessionRoute): GrokSessionState | undefined {
    let validated: GrokSessionRoute;
    try {
      validated = validateRoute(route);
    } catch {
      return undefined;
    }
    const key = routeKey(validated);
    const state = this.#sessions.get(key);
    return state && exactOwner(state, validated) ? snapshot(state) : undefined;
  }

  #requireClaim(claim: GrokProvisionalLoadClaim): MutableSessionState {
    const state = this.#claims.get(claim);
    if (
      !state ||
      state.residency !== "provisional_load" ||
      this.#sessions.get(routeKey(state)) !== state
    ) {
      throw new Error("grok_session_load_claim_invalid");
    }
    return state;
  }

  #requireExactOwner(
    route: GrokSessionRoute,
    residency: GrokSessionResidency,
  ): MutableSessionState {
    const validated = validateRoute(route);
    const state = this.#sessions.get(routeKey(validated));
    if (
      !state ||
      state.residency !== residency ||
      !exactOwner(state, validated)
    ) {
      throw new Error("grok_session_owner_mismatch");
    }
    return state;
  }
}

function validateRoute(route: GrokSessionRoute): GrokSessionRoute {
  if (
    !validEnvironmentChannelScope(route.scope) ||
    !boundedIdentifier(route.nativeNamespaceKey) ||
    !path.isAbsolute(route.workspace) ||
    path.resolve(route.workspace) !== route.workspace ||
    !boundedIdentifier(route.processOwnerId) ||
    !boundedIdentifier(route.sessionId) ||
    !Number.isSafeInteger(route.connectionGeneration) ||
    route.connectionGeneration < 1
  ) {
    throw new Error("grok_session_route_invalid");
  }
  return Object.freeze({
    scope: Object.freeze({ ...route.scope }),
    nativeNamespaceKey: route.nativeNamespaceKey,
    workspace: route.workspace,
    connectionGeneration: route.connectionGeneration,
    processOwnerId: route.processOwnerId,
    sessionId: route.sessionId,
  });
}

function exactOwner(left: GrokSessionRoute, right: GrokSessionRoute): boolean {
  return (
    sameProviderTransportScope(left.scope, right.scope) &&
    left.workspace === right.workspace &&
    left.nativeNamespaceKey === right.nativeNamespaceKey &&
    left.connectionGeneration === right.connectionGeneration &&
    left.processOwnerId === right.processOwnerId &&
    left.sessionId === right.sessionId
  );
}

function routeKey(route: GrokSessionRoute): string {
  return JSON.stringify([
    route.scope.tenantId,
    route.scope.principalId,
    route.scope.backendInstanceId,
    route.scope.executionEnvironmentId,
    route.nativeNamespaceKey,
    route.workspace,
    route.sessionId,
  ]);
}

function processOwnerKey(route: GrokSessionRoute): string {
  return JSON.stringify([
    route.scope.tenantId,
    route.scope.principalId,
    route.scope.backendInstanceId,
    route.scope.executionEnvironmentId,
    route.processOwnerId,
  ]);
}

function boundedIdentifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 1_024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function snapshot(state: MutableSessionState): GrokSessionState {
  return Object.freeze({
    scope: Object.freeze({ ...state.scope }),
    nativeNamespaceKey: state.nativeNamespaceKey,
    workspace: state.workspace,
    connectionGeneration: state.connectionGeneration,
    processOwnerId: state.processOwnerId,
    sessionId: state.sessionId,
    residency: state.residency,
  });
}
