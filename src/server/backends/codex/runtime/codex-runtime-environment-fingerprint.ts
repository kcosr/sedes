/** Projection for idempotency only. Native execution still receives the original
 * parameters. Credential rotations must not create durable secret-derived hashes. */
export function codexEnvironmentFingerprintInput(method: string, params: unknown, definitionsFingerprint?: string): unknown {
  if (!["thread/start", "thread/resume", "thread/fork"].includes(method) || !record(params) || !record(params.config)) return params;
  const config = params.config;
  const policy = config.shell_environment_policy;
  if (!record(policy) || !record(policy.set)) return params;
  return { ...params, config: { ...config, shell_environment_policy: { ...policy,
    set: { names: Object.keys(policy.set).sort(), definitionsFingerprint: definitionsFingerprint ?? null },
  } } };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
