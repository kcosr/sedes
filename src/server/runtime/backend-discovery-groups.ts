import type { AgentConnectionProfile } from "../backends/contracts.js";

export interface BackendDiscoveryGroupCandidate {
  readonly profile: AgentConnectionProfile;
  readonly nativeNamespaceKey: string;
  readonly isDefault: boolean;
}

export interface BackendDiscoveryGroup {
  readonly profile: AgentConnectionProfile;
  readonly connectionProfileIds: readonly string[];
}

type MutableGroup = {
  profile: AgentConnectionProfile;
  isDefault: boolean;
  readonly connectionProfileIds: Set<string>;
};

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Groups principal-scoped profiles that address one provider-native discovery
 * namespace. The configured default is the representative when present, while
 * every equivalent profile ID remains in the reconciliation scope.
 */
export function groupBackendDiscoveryProfiles(
  candidates: readonly BackendDiscoveryGroupCandidate[],
): readonly BackendDiscoveryGroup[] {
  const groups = new Map<string, MutableGroup>();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      candidate.profile.backendInstanceId,
      candidate.profile.executionEnvironmentId,
      candidate.nativeNamespaceKey,
    ]);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        profile: candidate.profile,
        isDefault: candidate.isDefault,
        connectionProfileIds: new Set([candidate.profile.id]),
      });
      continue;
    }
    current.connectionProfileIds.add(candidate.profile.id);
    if (!current.isDefault && candidate.isDefault) {
      current.profile = candidate.profile;
      current.isDefault = true;
    }
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareOpaque(left, right))
      .map(([, group]) =>
        Object.freeze({
          profile: group.profile,
          connectionProfileIds: Object.freeze(
            [...group.connectionProfileIds].sort(compareOpaque),
          ),
        }),
      ),
  );
}
