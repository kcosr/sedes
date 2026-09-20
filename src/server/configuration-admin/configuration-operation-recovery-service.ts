import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  configurationOperationRecoveryAcknowledgmentSchema,
  configurationOperationRecoveryDetailsSchema,
  configurationOperationRecoveryListSchema,
  configurationOperationRecoveryReferenceSchema,
  configurationOperationRecoveryAcknowledgeRequestSchema,
  type ConfigurationOperationRecoveryKind,
  type ConfigurationOperationRecoveryReference,
  type ConfigurationOperationRecoveryInspection,
} from "../../shared/protocol/configuration-operation-recovery.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarOperationRecoveryClient } from "../sidecar/sidecar-operation-recovery-client.js";

export interface ConfigurationOperationRecoveryLease {
  readonly client: Pick<SidecarOperationRecoveryClient, "list" | "inspect" | "acknowledge">;
  readonly serviceIncarnation: string;
  release(): void | Promise<void>;
}
export interface ConfigurationOperationRecoveryDependencies {
  authorize(scope: RequestScope): void | Promise<void>;
  acquire(scope: RequestScope, environmentId: string): Promise<ConfigurationOperationRecoveryLease>;
  kinds(scope: RequestScope, environmentId: string): readonly ConfigurationOperationRecoveryKind[] | Promise<readonly ConfigurationOperationRecoveryKind[]>;
  readonly now?: () => number;
}
interface Confirmation {
  readonly scopeKey: string;
  readonly environmentId: string;
  readonly reference: ConfigurationOperationRecoveryReference;
  readonly incarnation: string;
  readonly fingerprint: string;
  readonly expiresAt: number;
}

/** Read-only recovery inspection and explicitly confirmed receipt disposition. */
export class ConfigurationOperationRecoveryService {
  readonly #confirmations = new Map<string, Confirmation>();
  readonly #now: () => number;
  constructor(readonly dependencies: ConfigurationOperationRecoveryDependencies) {
    this.#now = dependencies.now ?? Date.now;
  }

  async list(scope: RequestScope, environmentId: string) {
    const kinds = await this.#authorize(scope, environmentId);
    if (kinds.length === 0) return { receipts: [] };
    const lease = await this.dependencies.acquire(scope, environmentId);
    try {
      const result = configurationOperationRecoveryListSchema.parse(await lease.client.list(kinds));
      if (result.receipts.some(receipt => !kinds.includes(receipt.kind))) {
        throw new DomainError("conflict", "Operation recovery returned an ungranted receipt kind.");
      }
      return result;
    } finally { await lease.release(); }
  }

  async inspect(scope: RequestScope, environmentId: string, value: ConfigurationOperationRecoveryReference): Promise<ConfigurationOperationRecoveryInspection> {
    const kinds = await this.#authorize(scope, environmentId);
    const reference = configurationOperationRecoveryReferenceSchema.parse(value);
    this.#assertKind(kinds, reference.kind);
    const lease = await this.dependencies.acquire(scope, environmentId);
    try {
      const operation = await this.#inspect(lease, reference);
      let confirmationToken: string | null = null;
      if (operation.acknowledgeable) {
        this.#prune();
        while (this.#confirmations.size >= 256) this.#confirmations.delete(this.#confirmations.keys().next().value!);
        confirmationToken = randomUUID();
        this.#confirmations.set(confirmationToken, {
          scopeKey: this.#scopeKey(scope), environmentId, reference, incarnation: lease.serviceIncarnation,
          fingerprint: configurationFingerprint(operation), expiresAt: this.#now() + 120_000,
        });
      }
      return { operation, confirmationToken };
    } finally { await lease.release(); }
  }

  async acknowledge(scope: RequestScope, environmentId: string, value: ConfigurationOperationRecoveryReference, request: { confirmationToken: string }) {
    const kinds = await this.#authorize(scope, environmentId);
    const reference = configurationOperationRecoveryReferenceSchema.parse(value);
    this.#assertKind(kinds, reference.kind);
    const { confirmationToken } = configurationOperationRecoveryAcknowledgeRequestSchema.parse(request);
    this.#prune();
    const confirmation = this.#confirmations.get(confirmationToken);
    if (!confirmation || confirmation.scopeKey !== this.#scopeKey(scope) || confirmation.environmentId !== environmentId
      || confirmation.reference.kind !== reference.kind || confirmation.reference.receiptId !== reference.receiptId) {
      throw new DomainError("conflict", "Inspect this operation again before acknowledging it.");
    }
    // Single use even when transport delivery or release later becomes uncertain.
    this.#confirmations.delete(confirmationToken);
    const lease = await this.dependencies.acquire(scope, environmentId);
    try {
      if (lease.serviceIncarnation !== confirmation.incarnation) {
        throw new DomainError("conflict", "The execution service changed. Inspect this operation again.");
      }
      const operation = await this.#inspect(lease, reference);
      if (!operation.acknowledgeable || lease.serviceIncarnation !== confirmation.incarnation || confirmation.expiresAt <= this.#now() || configurationFingerprint(operation) !== confirmation.fingerprint) {
        throw new DomainError("conflict", "The operation outcome changed. Inspect it again before acknowledging.");
      }
      return configurationOperationRecoveryAcknowledgmentSchema.parse(await lease.client.acknowledge(reference));
    } finally { await lease.release(); }
  }

  async #authorize(scope: RequestScope, environmentId: string) {
    await this.dependencies.authorize(scope);
    z.string().uuid().parse(environmentId);
    return [...new Set(await this.dependencies.kinds(scope, environmentId))];
  }
  #assertKind(kinds: readonly ConfigurationOperationRecoveryKind[], kind: ConfigurationOperationRecoveryKind) {
    if (!kinds.includes(kind)) throw new DomainError("not_found", "Operation recovery is unavailable for this capability.");
  }
  async #inspect(lease: ConfigurationOperationRecoveryLease, reference: ConfigurationOperationRecoveryReference) {
    const operation = configurationOperationRecoveryDetailsSchema.parse(await lease.client.inspect(reference));
    if (operation.kind !== reference.kind || operation.receiptId !== reference.receiptId) throw new DomainError("conflict", "Operation recovery returned a different receipt.");
    return operation;
  }
  #scopeKey(scope: RequestScope) { return JSON.stringify([scope.tenantId, scope.principalId]); }
  #prune() {
    const now = this.#now();
    for (const [token, confirmation] of this.#confirmations) if (confirmation.expiresAt <= now) this.#confirmations.delete(token);
  }
}
