import { createHash } from "node:crypto";

import type {
  OutputArtifactPublisher,
  OutputImageArtifactDescriptor,
} from "../../src/server/output-artifacts/contracts.js";

function deterministicArtifactId(identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Process-local deterministic publisher for tests that do not exercise storage. */
export function createInMemoryOutputArtifactPublisher(): OutputArtifactPublisher {
  const images = new Map<string, OutputImageArtifactDescriptor>();
  const key = (
    tenantId: string,
    principalId: string,
    threadId: string,
    publicationKey: string,
  ) => `${tenantId}\0${principalId}\0${threadId}\0${publicationKey}`;
  return {
    findImage: (scope, threadId, publicationKey) =>
      images.get(
        key(scope.tenantId, scope.principalId, threadId, publicationKey),
      ),
    publishImage: async (input) => {
      const identity = key(
        input.scope.tenantId,
        input.scope.principalId,
        input.threadId,
        input.publicationKey,
      );
      const descriptor = {
        artifactId: deterministicArtifactId(identity),
        mediaType: input.mediaType,
        byteSize: input.bytes.byteLength,
        sha256:
          input.expectedSha256 ??
          createHash("sha256").update(input.bytes).digest("hex"),
      } as const;
      const existing = images.get(identity);
      if (
        existing &&
        (existing.mediaType !== descriptor.mediaType ||
          existing.byteSize !== descriptor.byteSize ||
          existing.sha256 !== descriptor.sha256)
      ) {
        throw new Error("test_output_artifact_publication_conflict");
      }
      images.set(identity, existing ?? descriptor);
      return existing ?? descriptor;
    },
  };
}
