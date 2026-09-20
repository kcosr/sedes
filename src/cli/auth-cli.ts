import { AuthenticationRepository } from "../server/authentication/authentication-repository.js";
import { resolveBackendConfigurationFilename } from "../server/config/backend-configuration.js";
import { loadBootstrapConfigurationFile } from "../server/config/bootstrap-configuration.js";
import { loadConfig } from "../server/config/config.js";
import type { SedesCliIo } from "./sedes-cli.js";

const usage = `Usage:
  sedes auth pair --server URL [--sidecar]
  sedes auth list
  sedes auth revoke CLIENT_ID

Run on the server as its operating-system account, with the same
SEDES_CONFIG_FILE and environment as the running Sedes server.
Eight-letter pairing codes (XXXX-YYYY) expire after five minutes and can be used exactly once.
`;

export async function runAuthCli(args: readonly string[], dependencies: {
  environment?: NodeJS.ProcessEnv;
  io?: SedesCliIo;
} = {}): Promise<number> {
  const io = dependencies.io ?? process;
  const environment = dependencies.environment ?? process.env;
  let repository: AuthenticationRepository | undefined;
  try {
    if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
      io.stdout.write(usage);
      return 0;
    }
    const [command, ...options] = args;
    let server: URL | undefined;
    let sidecar = false;
    if (command === "pair") {
      for (let i = 0; i < options.length; i++) {
        if (options[i] === "--server" && server === undefined && options[i + 1]) server = new URL(options[++i]!);
        else if (options[i] === "--sidecar" && !sidecar) sidecar = true;
        else throw new Error("Unknown or duplicate pairing option.");
      }
      if (!server || !["http:", "https:"].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== "/") {
        throw new Error("--server must be an HTTP(S) server origin without credentials, path, query, or fragment.");
      }
    } else if (command === "list") {
      if (options.length !== 0) throw new Error("auth list takes no arguments.");
    } else if (command === "revoke") {
      if (options.length !== 1 || !/^[0-9a-f-]{36}$/u.test(options[0]!)) throw new Error("auth revoke requires one client ID from auth list.");
    } else throw new Error("Unknown auth command.");

    const bootstrap = await loadBootstrapConfigurationFile(resolveBackendConfigurationFilename(environment));
    repository = new AuthenticationRepository(loadConfig(environment, bootstrap).stateDirectory);
    if (command === "pair") {
      const pairing = repository.createPairing({ kind: sidecar ? "sidecar" : "management" });
      server!.hash = `pair=${pairing.token}`;
      io.stdout.write(JSON.stringify({ url: server!.href, code: pairing.token, kind: sidecar ? "sidecar" : "management", expiresAt: pairing.expiresAt }) + "\n");
    } else if (command === "list") {
      io.stdout.write(JSON.stringify({ clients: repository.listClients() }) + "\n");
    } else {
      if (!repository.revokeClient(options[0]!)) throw new Error("Active client not found.");
      io.stdout.write("Client revoked.\n");
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "Authentication command failed."}\n${usage}`);
    return 1;
  } finally { repository?.close(); }
}
