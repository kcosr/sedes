import { randomUUID } from "node:crypto";
import { workspaceContextReadOperation } from "../../internal/sidecar-protocol/index.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../sidecar/sidecar-runtime.js";
import type { WorkspaceContextReader } from "./contracts.js";

export class SidecarWorkspaceContextReader implements WorkspaceContextReader {
  readonly #admissionId = randomUUID();
  constructor(
    private readonly input: {
      readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
      readonly scope: RequestScope;
      readonly environmentId: string;
      readonly declaredPath: string;
      readonly policyRootPath: string;
    },
  ) {}
  async read(signal?: AbortSignal) {
    const lease = await this.input.runtime.acquireOperation(
      this.input.scope,
      this.input.environmentId,
      signal ?? new AbortController().signal,
    );
    try {
      return await lease.session.call(
        workspaceContextReadOperation,
        {
          admissionId: this.#admissionId,
          declaredPath: this.input.declaredPath,
          policyRootPath: this.input.policyRootPath,
        },
        ...(signal ? ([{ signal }] as const) : []),
      );
    } finally {
      lease.release();
    }
  }
}
