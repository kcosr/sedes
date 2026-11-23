/**
 * A runtime identity proof shows that the admitted native daemon, not a
 * replacement on the same endpoint, is still serving the carrier attachment.
 * Callers place a proof after native reads so those results are attributable
 * to the admitted daemon.
 *
 * A proof may satisfy another request only when it was issued after every
 * native call on the same attachment had completed and no native call has
 * started since. Any caller may share a proof that is still in flight under
 * that rule. A completed proof is reusable only through the explicit scope of
 * the operation that observed it, so adjacent steps of one operation can share
 * it while health checks and later operations always prove identity again.
 */
export interface OpenCodeIdentityProof {
  /** Carrier attachment that issued the proof. */
  readonly owner: object;
  /** Runtime ID and native generation the proof covers. */
  readonly generationKey: string;
  /** Native-call epoch on the owner when the proof was issued. */
  readonly epoch: number;
  /** No native call was in flight on the owner when the proof was issued. */
  readonly quiescent: boolean;
  readonly promise: Promise<void>;
  readonly settled: boolean;
  readonly succeeded: boolean;
}

/** Proofs observed by one operation. Create one per operation; never retain it. */
export class OpenCodeIdentityProofScope {
  #latest: OpenCodeIdentityProof | undefined;
  get latest(): OpenCodeIdentityProof | undefined { return this.#latest; }
  record(proof: OpenCodeIdentityProof): void { this.#latest = proof; }
}
