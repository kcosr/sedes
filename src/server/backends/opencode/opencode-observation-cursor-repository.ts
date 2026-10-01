import type Database from "better-sqlite3";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { openCodeNativeAuthoritySchema, openCodeObservationCursorSchema } from "./opencode-native-codecs.js";
import type { OpenCodeNativeAuthority, OpenCodeObservationCursor } from "./opencode-native-port.js";

export interface OpenCodeObservationCheckpoint extends OpenCodeObservationCursor {
  readonly runtimeId: string; readonly nativeGeneration: string; readonly nativeContinuity: string;
}
/** Exact provider cursor, committed atomically with application input evidence. */
export class OpenCodeObservationCursorRepository {
  readonly #key: readonly string[];
  readonly #authorityFingerprint: string;
  constructor(readonly database: Database.Database, readonly authority: OpenCodeNativeAuthority, namespace: string) {
    openCodeNativeAuthoritySchema.parse(authority);
    if (!authority.session || !namespace) throw conflict();
    this.#key = [authority.tenantId, authority.principalId, authority.session.applicationThreadId,
      namespace, authority.session.nativeSessionID, authority.session.bindingFingerprint];
    const { runtimeId: _runtime, nativeGeneration: _generation, ...scope } = authority;
    this.#authorityFingerprint = configurationFingerprint(scope);
  }
  read(): OpenCodeObservationCheckpoint | undefined {
    const row = this.database.prepare(`SELECT authority_fingerprint AS authorityFingerprint,
      runtime_id AS runtimeId,native_generation AS nativeGeneration,journal_id AS journalId,
      sequence,native_continuity AS nativeContinuity FROM opencode_observation_cursors
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND native_namespace_key=?
        AND native_session_id=? AND binding_fingerprint=?`).get(...this.#key) as
        (OpenCodeObservationCheckpoint & { authorityFingerprint: string }) | undefined;
    if (!row) return;
    if (row.authorityFingerprint !== this.#authorityFingerprint) throw conflict();
    const { authorityFingerprint: _scope, ...checkpoint } = row;
    return checkpoint;
  }
  commit(expected: OpenCodeObservationCheckpoint | undefined, next: OpenCodeObservationCheckpoint,
    apply: () => void, input: { readonly reset: boolean }): void {
    openCodeObservationCursorSchema.parse({ journalId: next.journalId, sequence: next.sequence });
    if (next.runtimeId !== this.authority.runtimeId || next.nativeGeneration !== this.authority.nativeGeneration ||
        !next.nativeContinuity || next.nativeContinuity.length > 256) throw conflict();
    this.database.transaction(() => {
      const current = this.read();
      if (configurationFingerprint(current ?? null) !== configurationFingerprint(expected ?? null)) throw conflict();
      if (!input.reset && (!current || current.journalId !== next.journalId || current.runtimeId !== next.runtimeId ||
          current.nativeGeneration !== next.nativeGeneration || (next.sequence !== current.sequence && next.sequence !== current.sequence + 1))) throw conflict();
      apply();
      this.database.prepare(`INSERT INTO opencode_observation_cursors
        (tenant_id,owner_principal_id,application_thread_id,native_namespace_key,native_session_id,binding_fingerprint,
          authority_fingerprint,runtime_id,native_generation,journal_id,sequence,native_continuity)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id,owner_principal_id,application_thread_id,native_namespace_key,native_session_id,binding_fingerprint)
        DO UPDATE SET runtime_id=excluded.runtime_id,native_generation=excluded.native_generation,journal_id=excluded.journal_id,
          sequence=excluded.sequence,native_continuity=excluded.native_continuity`).run(...this.#key, this.#authorityFingerprint,
          next.runtimeId, next.nativeGeneration, next.journalId, next.sequence, next.nativeContinuity);
    }).immediate();
  }
}
function conflict() { return new OpenCodeRuntimeError("opencode_observation_cursor_conflict"); }
