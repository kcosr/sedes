/** Closed command-line Git configuration for host-side sandbox repository work. */
export const PI_SANDBOX_HARDENED_GIT_ARGUMENTS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
] as const);

/**
 * Deliberately excludes ambient Git, HOME, SSH, askpass, object-store, and
 * repository-selection variables from the Sedes process.
 */
export function piSandboxHardenedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}
