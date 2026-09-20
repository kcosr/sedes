import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";

export interface ConfigurationRemovalGuard {
  /** Prove the backend is safely stopped and fence new admission through commit. */
  withBackendStopped<T>(id: string, callback: () => Promise<T>): Promise<T>;
  /** Prove the environment is safely stopped and fence new admission through commit. */
  withEnvironmentStopped<T>(id: string, callback: () => Promise<T>): Promise<T>;
}

/** Retain definitions until every removed resource is safe. The composition
 * root owns runtime proofs; all acquired fences remain held through commit. */
export async function commitWithConfigurationRemovalGuard<T>(input: ConfigurationRemovalGuard & {
  readonly previous: ConfigurationDocument;
  readonly next: ConfigurationDocument;
  readonly commit: () => T | Promise<T>;
}): Promise<T> {
  const nextBackends = new Set(input.next.backends.map(backend => backend.id));
  const nextTargets = new Set(input.next.targets.map(target => target.id));
  const nextEnvironments = new Set(input.next.executionEnvironments.map(environment => environment.id));
  const backends = new Set(input.previous.backends.filter(backend => !nextBackends.has(backend.id)).map(backend => backend.id));
  for (const target of input.previous.targets) if (!nextTargets.has(target.id)) backends.add(target.backendInstanceId);
  const environments = input.previous.executionEnvironments.filter(environment => !nextEnvironments.has(environment.id)).map(environment => environment.id);
  const fences: Array<(callback: () => Promise<T>) => Promise<T>> = [
    ...[...backends].sort().map(id => (callback: () => Promise<T>) => input.withBackendStopped(id, callback)),
    ...[...new Set(environments)].sort().map(id => (callback: () => Promise<T>) => input.withEnvironmentStopped(id, callback)),
  ];
  const enter = async (index: number): Promise<T> => index === fences.length
    ? input.commit()
    : fences[index]!(() => enter(index + 1));
  return enter(0);
}
