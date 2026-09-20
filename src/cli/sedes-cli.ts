import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deterministicJson } from "../server/canonical-json.js";
import { compileCanonicalAgentToolSchema } from "../server/agent-tools/schema/canonical-json-schema.js";
import { AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS } from "../server/agent-tools/contracts/agent-tool-transport-limits.js";
import {
  SedesToolApiError,
  normalizeSedesAgentToolClientToken,
  normalizeSedesAgentToolSourceCapability,
  type SedesAgentToolCallerCredential,
  type SedesToolClient,
} from "./sedes-tool-client.js";
import {
  SEDES_AGENT_TOOL_ENDPOINT_VARIABLE,
  SEDES_AGENT_TOOL_CLI_MODE_VARIABLE,
  SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE,
  normalizeSedesAgentToolCliMode,
  normalizeSedesAgentToolEndpoint,
  type SedesAgentToolCliMode,
} from "./sedes-agent-tool-endpoint.js";
import { SEDES_VERSION } from "../shared/version.js";
import { createSedesToolClient } from "./create-sedes-tool-client.js";
import type { SedesToolLocalSocketConnector } from "./sedes-tool-local-client.js";
import {
  parseDynamicToolInput,
  renderDynamicToolHelp,
  resolveDynamicCommand,
  resolveDynamicHelp,
  SedesDynamicCliUsageError,
} from "./sedes-dynamic-tool-command.js";

export interface SedesCliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
}

export interface SedesCliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly io?: SedesCliIo;
  readonly fetch?: typeof globalThis.fetch;
  readonly connect?: SedesToolLocalSocketConnector;
  readonly transportRequestId?: () => string;
  readonly id?: () => string;
  readonly signal?: AbortSignal;
  readonly readFile?: (path: string) => Promise<string>;
  readonly readStdin?: () => Promise<string>;
}

const progressiveUsage = `Usage:
  sedes --version
  sedes tool list --json
  sedes tool describe TOOL_ID [TOOL_ID ...] --json
  sedes tool invoke TOOL_ID (--input-json <json> | --input-file <path|->) --json

Successful invocation stdout matches the described tool outputSchema.
`;

const individualUsage = `Usage:
  sedes --help
  sedes --version
  sedes <group> --help
  sedes <group> <command> --help
  sedes <group> <command> [typed named options] [--json]

Help is generated from the currently exposed catalog and schemas.
Successful invocations emit the operation's canonical JSON output.
`;

class SedesCliUsageError extends Error {}

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "dynamic_help"; readonly path: readonly string[] }
  | { readonly kind: "list"; readonly json: boolean }
  | {
      readonly kind: "describe";
      readonly toolIds: readonly string[];
      readonly json: boolean;
    }
  | {
      readonly kind: "invoke";
      readonly toolId: string;
      readonly source:
        | { readonly kind: "json"; readonly value: string }
        | { readonly kind: "file"; readonly value: string };
      readonly json: boolean;
    }
  | { readonly kind: "dynamic"; readonly arguments: readonly string[] };

function parseJsonFlag(arguments_: readonly string[]): boolean {
  if (arguments_.length === 1 && arguments_[0] === "--json") return true;
  throw new SedesCliUsageError(
    "Progressive CLI commands require exactly one --json option.",
  );
}

function parseCommand(
  arguments_: readonly string[],
  mode: SedesAgentToolCliMode,
): ParsedCommand {
  // Build identification stays mode-independent so a bug report can name the
  // binary's version without first discovering which CLI mode is configured.
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--version" || arguments_[0] === "-v")
  ) {
    return { kind: "version" };
  }
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    return mode === "progressive"
      ? { kind: "help" }
      : { kind: "dynamic_help", path: [] };
  }
  const [group, action, identifier, ...remaining] = arguments_;
  if (mode === "individual") {
    if (group === "tool") {
      throw new SedesCliUsageError(
        "Generic tool commands are unavailable in individual CLI mode; use sedes --help.",
      );
    }
    const help = arguments_.at(-1);
    if (
      arguments_.length > 1 &&
      (help === "--help" || help === "-h") &&
      arguments_.slice(0, -1).every((word) => /^[a-z][a-z0-9-]*$/.test(word))
    ) {
      return { kind: "dynamic_help", path: arguments_.slice(0, -1) };
    }
    if (arguments_.length > 0) {
      return { kind: "dynamic", arguments: [...arguments_] };
    }
    throw new SedesCliUsageError("A Sedes command is required.");
  }
  if (group === "tool" && action === "list") {
    return { kind: "list", json: parseJsonFlag(arguments_.slice(2)) };
  }
  if (group === "tool" && action === "describe" && identifier) {
    const json = remaining.at(-1) === "--json";
    if (!json) {
      throw new SedesCliUsageError(
        "Progressive CLI commands require exactly one --json option.",
      );
    }
    const toolIds = [
      identifier,
      ...remaining.slice(0, -1),
    ];
    if (
      toolIds.some((toolId) => toolId.startsWith("--")) ||
      toolIds.length > AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS ||
      new Set(toolIds).size !== toolIds.length
    ) {
      throw new SedesCliUsageError(
        `Describe requires 1-${AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS} unique tool IDs.`,
      );
    }
    return {
      kind: "describe",
      toolIds,
      json,
    };
  }
  if (group === "tool" && action === "invoke" && identifier) {
    let source: Extract<ParsedCommand, { kind: "invoke" }>["source"] | undefined;
    let json = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const option = remaining[index];
      if (option === "--json" && !json) {
        json = true;
        continue;
      }
      if (option === "--input-json" && source === undefined) {
        const value = remaining[++index];
        if (value === undefined) {
          throw new SedesCliUsageError("--input-json requires a value.");
        }
        source = { kind: "json", value };
        continue;
      }
      if (option?.startsWith("--input-json=") && source === undefined) {
        const value = option.slice("--input-json=".length);
        if (value.length === 0) {
          throw new SedesCliUsageError("--input-json requires a value.");
        }
        source = { kind: "json", value };
        continue;
      }
      if (option === "--input-file" && source === undefined) {
        const value = remaining[++index];
        if (value === undefined || value.length === 0) {
          throw new SedesCliUsageError("--input-file requires a path or -.");
        }
        source = { kind: "file", value };
        continue;
      }
      if (option?.startsWith("--input-file=") && source === undefined) {
        const value = option.slice("--input-file=".length);
        if (value.length === 0) {
          throw new SedesCliUsageError("--input-file requires a path or -.");
        }
        source = { kind: "file", value };
        continue;
      }
      throw new SedesCliUsageError("Unknown or repeated command option.");
    }
    if (source === undefined) {
      throw new SedesCliUsageError("--input-json or --input-file is required.");
    }
    if (!json) {
      throw new SedesCliUsageError(
        "Progressive CLI commands require exactly one --json option.",
      );
    }
    return { kind: "invoke", toolId: identifier, source, json };
  }
  if (group === "tool") {
    throw new SedesCliUsageError(
      "A complete tool command and required tool ID are required.",
    );
  }
  if (arguments_.length > 0) {
    throw new SedesCliUsageError(
      "Named commands are unavailable in progressive CLI mode; use sedes tool list --json.",
    );
  }
  throw new SedesCliUsageError("A Sedes command is required.");
}

function writeJson(output: SedesCliIo["stdout"], value: unknown): void {
  output.write(`${deterministicJson(value)}\n`);
}

function renderInvocation(
  io: SedesCliIo,
  result: Awaited<ReturnType<SedesToolClient["invoke"]>>,
  json: boolean,
): number {
  if (result.state === "completed") writeJson(io.stdout, result.output);
  else if (json) writeJson(io.stdout, result);
  else if ("error" in result) io.stderr.write(`${result.error.message}\n`);
  else io.stderr.write(`Unexpected non-terminal invocation: ${result.state}\n`);
  return result.state === "completed" ? 0 : 1;
}

export async function runSedesCli(
  arguments_: readonly string[],
  dependencies: SedesCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const environment = dependencies.environment ?? process.env;
  const readers = {
    readFile:
      dependencies.readFile ??
      ((path: string) => readFile(path, { encoding: "utf8" })),
    readStdin: dependencies.readStdin ?? readProcessStdin,
  };
  // The version flag must work in any shell, before the agent-tool CLI mode
  // or endpoint environment is validated.
  if (arguments_.length === 1 && (arguments_[0] === "--version" || arguments_[0] === "-v")) {
    io.stdout.write(`sedes ${SEDES_VERSION}\n`);
    return 0;
  }
  let mode: SedesAgentToolCliMode | undefined;
  try {
    mode = normalizeSedesAgentToolCliMode(
      environment[SEDES_AGENT_TOOL_CLI_MODE_VARIABLE],
    );
    const parsed = parseCommand(arguments_, mode);
    if (parsed.kind === "version") {
      io.stdout.write(`sedes ${SEDES_VERSION}\n`);
      return 0;
    }
    if (parsed.kind === "help") {
      io.stdout.write(progressiveUsage);
      return 0;
    }
    const endpoint = normalizeSedesAgentToolEndpoint(
      environment[SEDES_AGENT_TOOL_ENDPOINT_VARIABLE],
    );
    const credential = normalizeCallerCredential(environment);
    const client = createSedesToolClient({
      endpoint,
      credential,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.connect ? { connect: dependencies.connect } : {}),
      ...(dependencies.transportRequestId
        ? { transportRequestId: dependencies.transportRequestId }
        : {}),
    });
    if (parsed.kind === "dynamic_help") {
      const catalog = await client.listTools(dependencies.signal);
      const resolved = resolveDynamicHelp(catalog.tools, parsed.path);
      if (resolved.kind === "catalog") {
        io.stdout.write(resolved.output);
        return 0;
      }
      const { tools } = await client.describeTools(
        [resolved.tool.id],
        dependencies.signal,
      );
      const tool = tools[0]!;
      io.stdout.write(
        renderDynamicToolHelp(tool, resolved.tool.cli!.commandPath),
      );
      return 0;
    }
    if (parsed.kind === "list") {
      const catalog = await client.listTools(dependencies.signal);
      writeJson(io.stdout, catalog);
      return 0;
    }
    if (parsed.kind === "describe") {
      const description = await client.describeTools(
        parsed.toolIds,
        dependencies.signal,
      );
      writeJson(io.stdout, description);
      return 0;
    }
    if (parsed.kind === "invoke") {
      let serializedInput: string;
      try {
        serializedInput =
          parsed.source.kind === "json"
            ? parsed.source.value
            : await (parsed.source.value === "-"
                ? readers.readStdin()
                : readers.readFile(parsed.source.value));
      } catch {
        throw new SedesCliUsageError(
          "Unable to read the selected tool input file.",
        );
      }
      const input = parseInputObject(serializedInput, parsed.source.kind);
      const { tools } = await client.describeTools(
        [parsed.toolId],
        dependencies.signal,
      );
      const tool = tools[0]!;
      const validator = compileCanonicalAgentToolSchema(tool.inputSchema);
      const serialized = deterministicJson(input);
      if (!validator.check(input)) {
        throw new SedesCliUsageError(
          "The tool input does not match its current canonical schema.",
        );
      }
      const serializedBytes = Buffer.byteLength(serialized, "utf8");
      if (serializedBytes > tool.execution.maximumInputBytes) {
        throw new SedesCliUsageError(
          `The serialized tool input exceeds the ${tool.execution.maximumInputBytes}-byte transport limit.`,
        );
      }
      return renderInvocation(
        io,
        await client.invoke(
          {
            toolId: tool.id,
            schemaVersion: tool.schemaVersion,
            requestId: (dependencies.id ?? randomUUID)(),
            input,
          },
          dependencies.signal,
        ),
        parsed.json,
      );
    }
    const catalog = await client.listTools(dependencies.signal);
    const resolved = resolveDynamicCommand(catalog.tools, parsed.arguments);
    const { tools } = await client.describeTools(
      [resolved.tool.id],
      dependencies.signal,
    );
    const tool = tools[0]!;
    if (
      resolved.arguments.length === 1 &&
      (resolved.arguments[0] === "--help" || resolved.arguments[0] === "-h")
    ) {
      io.stdout.write(
        renderDynamicToolHelp(tool, resolved.tool.cli!.commandPath),
      );
      return 0;
    }
    const dynamic = await parseDynamicToolInput(
      tool.inputSchema,
      resolved.arguments,
      readers,
    );
    if (
      !compileCanonicalAgentToolSchema(tool.inputSchema).check(dynamic.input)
    ) {
      throw new SedesCliUsageError(
        "The named command input does not match its current canonical schema.",
      );
    }
    const serialized = deterministicJson(dynamic.input);
    if (
      Buffer.byteLength(serialized, "utf8") > tool.execution.maximumInputBytes
    ) {
      throw new SedesCliUsageError(
        `The serialized tool input exceeds the ${tool.execution.maximumInputBytes}-byte transport limit.`,
      );
    }
    return renderInvocation(
      io,
      await client.invoke(
        {
          toolId: tool.id,
          schemaVersion: tool.schemaVersion,
          requestId: (dependencies.id ?? randomUUID)(),
          input: dynamic.input,
        },
        dependencies.signal,
      ),
      dynamic.json,
    );
  } catch (error) {
    if (dependencies.signal?.aborted) {
      io.stderr.write("Sedes command interrupted.\n");
      return 130;
    }
    if (
      error instanceof SedesCliUsageError ||
      error instanceof SedesDynamicCliUsageError
    ) {
      io.stderr.write(
        `${error.message}\n${mode === "individual" ? individualUsage : progressiveUsage}`,
      );
      return 2;
    }
    if (error instanceof SedesToolApiError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    io.stderr.write("The Sedes command failed.\n");
    return 1;
  }
}

function parseInputObject(value: string, source: "json" | "file"): object {
  let input: unknown;
  try {
    input = JSON.parse(value);
    deterministicJson(input);
  } catch {
    throw new SedesCliUsageError(
      source === "json"
        ? "--input-json must contain valid JSON."
        : "--input-file must contain valid JSON.",
    );
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SedesCliUsageError("Tool input must be a JSON object.");
  }
  return input;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeCallerCredential(
  environment: NodeJS.ProcessEnv,
): SedesAgentToolCallerCredential {
  const sourceCapability =
    environment[SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE];
  const clientToken = environment[SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE];
  if (Boolean(sourceCapability) === Boolean(clientToken)) {
    throw new SedesToolApiError(
      "invalid_environment",
      `Exactly one of ${SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE} or ${SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE} is required.`,
      false,
    );
  }
  return sourceCapability
    ? Object.freeze({
        kind: "thread_source" as const,
        value: normalizeSedesAgentToolSourceCapability(sourceCapability),
      })
    : Object.freeze({
        kind: "principal_client" as const,
        value: normalizeSedesAgentToolClientToken(clientToken),
      });
}
