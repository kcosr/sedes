import { randomUUID } from "node:crypto";
import type { CanonicalMutationSerializer } from "../workspace-files/canonical-mutation-serializer.js";
import {
  WorkspaceToolError,
  type WorkspaceToolExecutor,
  type WorkspaceToolRoot,
} from "./contracts.js";
import { WorkspaceToolEngine } from "./workspace-tool-engine.js";

export class DirectWorkspaceToolExecutor implements WorkspaceToolExecutor {
  readonly #engine: WorkspaceToolEngine;

  constructor(input: {
    readonly root: Omit<WorkspaceToolRoot, "operationKey"> & {
      readonly operationKey?: string;
    };
    readonly mutations?: CanonicalMutationSerializer;
  }) {
    this.#engine = new WorkspaceToolEngine({
      root: {
        ...input.root,
        operationKey: input.root.operationKey ?? randomUUID(),
      },
      ...(input.mutations ? { mutations: input.mutations } : {}),
    });
  }

  read(input: Parameters<WorkspaceToolExecutor["read"]>[0]) {
    return this.#engine.read(input);
  }
  write(input: Parameters<WorkspaceToolExecutor["write"]>[0]) {
    return this.#engine.write(input);
  }
  edit(input: Parameters<WorkspaceToolExecutor["edit"]>[0]) {
    return this.#engine.edit(input);
  }
  list(input: Parameters<WorkspaceToolExecutor["list"]>[0]) {
    return this.#engine.list(input);
  }
  find(input: Parameters<WorkspaceToolExecutor["find"]>[0]) {
    return this.#engine.find(input);
  }
  grep(input: Parameters<WorkspaceToolExecutor["grep"]>[0]) {
    return this.#engine.grep(input);
  }
  startShell(): ReturnType<WorkspaceToolExecutor["startShell"]> {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  }
}
