export interface WorkspaceContextFile {
  readonly policyRelativePath: string;
  readonly content: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface WorkspaceContextSnapshot {
  readonly files: WorkspaceContextFile[];
  readonly fingerprint: string;
}

/** Data-only instruction reader; implementations must never execute content. */
export interface WorkspaceContextReader {
  read(signal?: AbortSignal): Promise<WorkspaceContextSnapshot>;
}
