const FORWARDED_PROBE_ENVIRONMENT_NAMES = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "TZ",
] as const;

/**
 * Probe-only disposable provider environment. Production Grok must use
 * buildGrokChildEnvironment and the operator's native HOME/GROK_HOME instead.
 */
export function buildDisposableGrokProbeChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  grokHome: string,
  processHome: string,
): Readonly<Record<string, string>> {
  const child: Record<string, string> = {};
  for (const name of FORWARDED_PROBE_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  child.HOME = processHome;
  child.GROK_HOME = grokHome;
  child.NO_COLOR = "1";
  child.TERM = "dumb";
  child.GROK_OAUTH2_REFERRER = "sedes-probe";
  return Object.freeze(child);
}
