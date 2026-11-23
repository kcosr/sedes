import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";

interface BackendGrant {
  readonly id: string;
  readonly kind: string;
  readonly generation: number;
  readonly launchDigest: string;
  readonly managedTuiDigest?: string;
  readonly targets: readonly { readonly id: string; readonly generation: number }[];
}

export interface ProviderPolicyAttachment {
  readonly validateAgentToolRoute?: (backendInstanceId: string, endpoint: string, executableDirectory?: string, inheritedPath?: string, mergedPath?: string) => void;
  readonly getExecutionPolicy: () => {
    readonly backends: readonly BackendGrant[];
    readonly capabilities: readonly { readonly id: string; readonly generation: number }[];
  };
  readonly isRecoveryController?: () => boolean;
}

type Stamp = { id: string; kind: string; generation: number; launchDigest: string };
/** Runtime objects survive controller detach. Their admitted generation cannot
 * be renewed by another lookup, even if the saved ID has since been re-added. */
const admitted = new WeakMap<object, Stamp>();

export function launchAdmission(attachment: ProviderPolicyAttachment, kind: string, id: string, digest: string,
  enabledTargets?: readonly { readonly enabled: boolean; readonly templateId: string }[]) {
  const read = () => {
    if (attachment.isRecoveryController?.()) throw denied();
    const grant = attachment.getExecutionPolicy().backends.find(grant => grant.id === id && grant.kind === kind);
    if (!grant || grant.launchDigest !== digest || !grant.targets.length || enabledTargets?.some(target =>
      target.enabled && !grant.targets.some(item => item.id === target.templateId))) throw denied();
    return grant;
  };
  const grant = read();
  const assertCurrent = () => { if (read().generation !== grant.generation) throw denied(); };
  return {
    assertCurrent,
    bind(host: object) {
      assertCurrent();
      const prior = admitted.get(host);
      if (prior && (prior.id !== id || prior.kind !== kind || prior.generation !== grant.generation || prior.launchDigest !== digest)) throw denied();
      admitted.set(host, { id, kind, generation: grant.generation, launchDigest: digest });
    },
  };
}

/** A status read reports the resident launch contract even after desired policy changes. */
export function observedLaunchDigest(host?: object): string | undefined {
  return host && admitted.get(host)?.launchDigest;
}

export function currentBackendGrant(attachment: ProviderPolicyAttachment, host: object): BackendGrant {
  if (attachment.isRecoveryController?.()) throw denied();
  const original = admitted.get(host);
  const grant = original && attachment.getExecutionPolicy().backends.find(grant => grant.kind === original.kind &&
    grant.id === original.id && grant.generation === original.generation);
  if (!grant || !grant.targets.length) throw denied();
  return grant;
}

function denied(): SidecarOperationError {
  return new SidecarOperationError("backend_policy_denied", false);
}
