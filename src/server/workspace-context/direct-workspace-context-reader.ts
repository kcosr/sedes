import type {
  WorkspaceContextReader,
  WorkspaceContextSnapshot,
} from "./contracts.js";
import { discoverWorkspaceContext } from "./workspace-context-discovery.js";

export class DirectWorkspaceContextReader implements WorkspaceContextReader {
  readonly #workspacePath: string;
  readonly #policyRoots: readonly string[];

  constructor(input: {
    readonly workspacePath: string;
    readonly policyRoots: readonly string[];
  }) {
    this.#workspacePath = input.workspacePath;
    this.#policyRoots = Object.freeze([...input.policyRoots]);
  }

  async read(signal?: AbortSignal): Promise<WorkspaceContextSnapshot> {
    return await discoverWorkspaceContext({
      workspacePath: this.#workspacePath,
      policyRoots: this.#policyRoots,
      ...(signal ? { signal } : {}),
    });
  }
}
