/** Projection for idempotency only. Native execution still receives the original
 * parameters. Credential rotations must not create durable secret-derived hashes,
 * so shell variables and the Sedes MCP server environment contribute only names. */
export function codexEnvironmentFingerprintInput(method: string, params: unknown, definitionsFingerprint?: string): unknown {
  if (!["thread/start", "thread/resume", "thread/fork"].includes(method) || !record(params) || !record(params.config)) return params;
  const config = { ...params.config };
  let projected = false;
  const policy = config.shell_environment_policy;
  if (record(policy) && record(policy.set)) {
    config.shell_environment_policy = { ...policy,
      set: { names: Object.keys(policy.set).sort(), definitionsFingerprint: definitionsFingerprint ?? null },
    };
    projected = true;
  }
  const mcpServer = config["mcp_servers.sedes"];
  if (record(mcpServer) && record(mcpServer.env)) {
    config["mcp_servers.sedes"] = { ...mcpServer, env: { names: Object.keys(mcpServer.env).sort() } };
    projected = true;
  }
  return projected ? { ...params, config } : params;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
