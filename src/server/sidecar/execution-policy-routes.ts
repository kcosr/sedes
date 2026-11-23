import { createHash, randomUUID } from "node:crypto";
import {
  type ExecutionPolicySnapshot,
  type ExecutionPolicyRouteSubject,
} from "../../internal/sidecar-protocol/execution-policy.js";
import { type AgentToolRouteBinding } from "../../internal/sidecar-protocol/agent-tools-v6.js";
import { sidecarAgentToolCliMetadataSchema } from "../../internal/sidecar-protocol/control-v3.js";
import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";
import type { AgentToolCliLocalIngress } from "./agent-tool-cli-local-ingress.js";

type PreparedIngress = Pick<
  AgentToolCliLocalIngress,
  "endpointUrl" | "available" | "close"
>;
type State = "ready" | "preparing" | "failed" | "unsupported";
type Route = {
  binding: AgentToolRouteBinding;
  ingress?: PreparedIngress;
  pending?: Promise<void>;
  retryAt: number;
  attempt: number;
};
const retryMs = [1000, 2000, 4000, 8000, 16000, 30000];
/** Each listening endpoint identifies one admitted backend and feature generation. */
export class ExecutionPolicyRoutes {
  #retryTimer: NodeJS.Timeout | undefined;
  readonly #routes = new Map<string, Route>();
  constructor(
    readonly options: {
      readonly readPolicy: () => ExecutionPolicySnapshot;
      readonly start: (
        endpointKey: string,
        binding: AgentToolRouteBinding,
      ) => Promise<PreparedIngress>;
      readonly executableAvailable: () => Promise<boolean>;
      readonly endpointKey: string;
      readonly executableDirectory: string;
      readonly inheritedPath: string;
    },
  ) {}

  refresh(snapshot: ExecutionPolicySnapshot): void {
    const generation = snapshot.capabilities.find(
      (c) => c.id === "agent_tools_cli",
    )?.generation;
    for (const [id, route] of this.#routes) {
      const b = snapshot.backends.find((b) => b.id === id);
      if (
        generation !== route.binding.capabilityGeneration ||
        b?.generation !== route.binding.backendGeneration
      ) {
        this.#routes.delete(id);
        void route.ingress?.close().catch(() => {});
      }
    }
    if (!generation) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
      return;
    }
    for (const b of snapshot.backends) {
      let r = this.#routes.get(b.id);
      if (!r) {
        r = {
          binding: {
            backendInstanceId: b.id,
            backendGeneration: b.generation,
            capabilityGeneration: generation,
          },
          retryAt: 0,
          attempt: 0,
        };
        this.#routes.set(b.id, r);
      }
      if (r.ingress || r.pending || Date.now() < r.retryAt) continue;
      this.#prepare(r);
    }
  }
  #scheduleRetries(): void {
    clearTimeout(this.#retryTimer);
    const due = [...this.#routes.values()]
      .filter((r) => !r.pending && !r.ingress && r.retryAt > 0)
      .map((r) => r.retryAt);
    if (!due.length) {
      this.#retryTimer = undefined;
      return;
    }
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = undefined;
        // A detached, stopped or unsynchronized controller resumes preparation on its next normal sync.
        try {
          this.options.readPolicy();
        } catch {
          return;
        }
        for (const r of this.#routes.values()) {
          if (r.ingress || r.pending || r.retryAt > Date.now()) continue;
          this.#prepare(r);
        }
        this.#scheduleRetries();
      },
      Math.max(0, Math.min(...due) - Date.now()),
    );
    this.#retryTimer.unref();
  }
  #prepare(route: Route): void {
    const id = route.binding.backendInstanceId;
    // Each listener retains a distinct proof even when its subject generation survives a readiness outage.
    route.binding = { ...route.binding };
    const key = createHash("sha256")
      .update(
        JSON.stringify([this.options.endpointKey, route.binding, randomUUID()]),
      )
      .digest("hex")
      .slice(0, 24);
    route.pending = this.options
      .executableAvailable()
      .then((available) => {
        if (!available) throw new Error("sidecar_cli_executable_unavailable");
        if (this.#routes.get(id) !== route)
          throw new SidecarOperationError("sidecar_policy_route_denied");
        this.#assertGrant(route.binding);
        return this.options.start(key, route.binding);
      })
      .then(async (ingress) => {
        if (this.#routes.get(id) !== route) {
          await ingress.close();
          return;
        }
        try {
          this.#assertGrant(route.binding);
          this.#descriptor(ingress);
        } catch (error) {
          await ingress.close();
          throw error;
        }
        route.attempt = 0;
        route.ingress = ingress;
      })
      .catch(() => {
        const delay = retryMs[route.attempt++];
        route.retryAt =
          delay === undefined ? Date.now() + 300_000 : Date.now() + delay;
      })
      .finally(() => {
        delete route.pending;
        this.#scheduleRetries();
      });
  }
  async checkReadiness(id?: string): Promise<void> {
    const entries = id
      ? ([[id, this.#routes.get(id)]] as const)
      : [...this.#routes.entries()];
    const active = entries.filter(([, route]) => route?.ingress);
    if (!active.length) return;
    const installed = await this.options.executableAvailable();
    await Promise.all(
      active.map(async ([id, route]) => {
        const ingress = route?.ingress;
        if (!ingress || (installed && (await ingress.available()))) return;
        if (this.#routes.get(id) !== route || route!.ingress !== ingress)
          return;
        delete route!.ingress;
        route!.retryAt = Date.now() + 1000;
        this.#scheduleRetries();
        await ingress.close().catch(() => {});
      }),
    );
  }
  state(id?: string): State {
    if (id) {
      const route = this.#routes.get(id);
      return !route
        ? "unsupported"
        : route.ingress
          ? "ready"
          : route.pending || route.attempt <= retryMs.length
            ? "preparing"
            : "failed";
    }
    if ([...this.#routes.values()].some((r) => r.ingress)) return "ready";
    if (
      [...this.#routes.values()].some(
        (r) => r.pending || r.attempt <= retryMs.length,
      )
    )
      return "preparing";
    if ([...this.#routes.values()].some((r) => !r.ingress)) return "failed";
    return "ready";
  }
  assertBinding(binding: AgentToolRouteBinding): void {
    const route = this.#routes.get(binding.backendInstanceId);
    if (!route?.ingress || route.binding !== binding)
      throw new SidecarOperationError("sidecar_policy_route_denied");
    this.#assertGrant(binding);
  }
  #assertGrant(binding: AgentToolRouteBinding): void {
    const policy = this.options.readPolicy();
    if (
      !policy.backends.some(
        (b) =>
          b.id === binding.backendInstanceId &&
          b.generation === binding.backendGeneration,
      ) ||
      !policy.capabilities.some(
        (c) =>
          c.id === "agent_tools_cli" &&
          c.generation === binding.capabilityGeneration,
      )
    )
      throw new SidecarOperationError("sidecar_policy_route_denied");
  }
  binding(id: string): AgentToolRouteBinding {
    const route = this.#routes.get(id);
    if (!route?.ingress)
      throw new SidecarOperationError("sidecar_policy_route_unavailable");
    this.assertBinding(route.binding);
    return route.binding;
  }
  descriptor(subject: ExecutionPolicyRouteSubject) {
    const route =
      subject.backendInstanceId && this.#routes.get(subject.backendInstanceId);
    if (
      !route ||
      !route.ingress ||
      route.binding.capabilityGeneration !== subject.generation
    )
      throw new SidecarOperationError("sidecar_policy_route_denied");
    this.assertBinding(route.binding);
    return this.#descriptor(route.ingress);
  }
  endpoint(id: string): string | undefined {
    const route = this.#routes.get(id);
    if (!route?.ingress) return undefined;
    this.assertBinding(route.binding);
    return route.ingress.endpointUrl;
  }
  #descriptor(ingress: PreparedIngress) {
    return sidecarAgentToolCliMetadataSchema.parse({
      endpoint: ingress.endpointUrl,
      executableDirectory: this.options.executableDirectory,
      inheritedPath: this.options.inheritedPath,
    });
  }
  async close(): Promise<void> {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const routes = [...this.#routes.values()];
    this.#routes.clear();
    await Promise.all(
      routes.map(async (route) => {
        await route.pending;
        await route.ingress?.close();
      }),
    );
  }
}
