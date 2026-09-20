import type {
  CanonicalAgentToolRootSchema,
  CanonicalAgentToolSchema,
} from "../server/agent-tools/schema/canonical-json-schema.js";
import {
  canonicalCliOptionSpecs,
  type CanonicalCliOptionSpec,
} from "../server/agent-tools/schema/canonical-cli-options.js";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
} from "../server/agent-tools/contracts/agent-tool-contracts.js";
import { deterministicJson } from "../server/canonical-json.js";

export class SedesDynamicCliUsageError extends Error {}

export interface SedesDynamicCliInputReaders {
  readonly readFile: (path: string) => Promise<string>;
  readonly readStdin: () => Promise<string>;
}

export interface ResolvedDynamicCommand {
  readonly tool: AgentToolCatalogSummary;
  readonly arguments: readonly string[];
}

export type ResolvedDynamicHelp =
  | Readonly<{ readonly kind: "catalog"; readonly output: string }>
  | Readonly<{
      readonly kind: "command";
      readonly tool: AgentToolCatalogSummary;
    }>;

type OptionSpec = CanonicalCliOptionSpec;

export function resolveDynamicCommand(
  tools: readonly AgentToolCatalogSummary[],
  arguments_: readonly string[],
): ResolvedDynamicCommand {
  const candidates = tools
    .flatMap((tool) => (tool.cli ? [{ tool, path: tool.cli.commandPath }] : []))
    .filter(({ path }) =>
      path.every((word, index) => arguments_[index] === word),
    )
    .sort((left, right) => right.path.length - left.path.length);
  const selected = candidates[0];
  if (
    !selected ||
    (candidates[1] && candidates[1].path.length === selected.path.length)
  ) {
    throw new SedesDynamicCliUsageError(
      "Unknown or ambiguous Sedes command.",
    );
  }
  return {
    tool: selected.tool,
    arguments: arguments_.slice(selected.path.length),
  };
}

export function resolveDynamicHelp(
  tools: readonly AgentToolCatalogSummary[],
  prefix: readonly string[],
): ResolvedDynamicHelp {
  const exposed = tools
    .flatMap((tool) => (tool.cli ? [{ tool, path: tool.cli.commandPath }] : []))
    .filter(({ path }) =>
      prefix.every((word, index) => path[index] === word),
    );
  if (prefix.length > 0 && exposed.length === 0) {
    throw usage("Unknown Sedes command group.");
  }
  const exact = exposed.find(({ path }) => path.length === prefix.length);
  if (exact) return { kind: "command", tool: exact.tool };
  return { kind: "catalog", output: renderDynamicCatalogHelp(exposed, prefix) };
}

export function renderDynamicCatalogHelp(
  exposed: readonly {
    readonly tool: AgentToolCatalogSummary;
    readonly path: readonly string[];
  }[],
  prefix: readonly string[],
): string {
  const sorted = [...exposed].sort(
    (left, right) =>
      left.tool.group.order - right.tool.group.order ||
      compareWords(left.path, right.path),
  );
  const lines = [
    prefix.length === 0
      ? "Usage: sedes <command> [options]"
      : `Usage: sedes ${prefix.join(" ")} <command> [options]`,
    "",
    prefix.length === 0
      ? "Available commands:"
      : `Available ${prefix.join(" ")} commands:`,
  ];
  if (sorted.length === 0) lines.push("  (none)");
  else {
    for (const { tool, path } of sorted) {
      lines.push(
        `  ${path.slice(prefix.length).join(" ")}  ${tool.description}`,
      );
    }
  }
  lines.push(
    "",
    prefix.length === 0
      ? "Run sedes <command> --help for live typed options."
      : `Run sedes ${prefix.join(" ")} <command> --help for live typed options.`,
    "Successful invocations emit the operation's canonical JSON output.",
    "",
  );
  return lines.join("\n");
}

export async function parseDynamicToolInput(
  schema: CanonicalAgentToolRootSchema,
  arguments_: readonly string[],
  readers: SedesDynamicCliInputReaders,
): Promise<{ readonly input: object; readonly json: boolean }> {
  const specs = optionSpecs(schema);
  let inputFile: string | undefined;
  let json = false;
  const supplied: Array<{ readonly spec: OptionSpec; readonly value: string }> =
    [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--json") {
      if (json) throw usage("--json may be supplied only once.");
      json = true;
      continue;
    }
    const parsed = splitOption(argument);
    if (parsed.name === "input-file") {
      if (inputFile !== undefined) {
        throw usage("--input-file may be supplied only once.");
      }
      inputFile = parsed.inlineValue ?? arguments_[++index];
      if (inputFile === undefined || inputFile.length === 0) {
        throw usage("--input-file requires a path or - for stdin.");
      }
      continue;
    }
    const spec = specs.get(parsed.name);
    if (!spec) throw usage(`Unknown command option --${parsed.name}.`);
    const value = parsed.inlineValue ?? arguments_[++index];
    if (value === undefined) {
      throw usage(`--${parsed.name} requires a value.`);
    }
    supplied.push({ spec, value });
  }

  if (inputFile !== undefined) {
    if (supplied.length > 0) {
      throw usage("--input-file cannot be mixed with named input options.");
    }
    return {
      input: parseObjectJson(await readInput(inputFile, readers), "input file"),
      json,
    };
  }

  const input: Record<string, unknown> = {};
  const assigned = new Map<string, { readonly repeatable: boolean }>();
  for (const { spec, value: rawValue } of supplied) {
    const pathKey = spec.path.join("\u0000");
    const conflicting = [...assigned.keys()].find(
      (other) =>
        other !== pathKey &&
        (other.startsWith(`${pathKey}\u0000`) ||
          pathKey.startsWith(`${other}\u0000`)),
    );
    if (conflicting) {
      throw usage(`--${spec.name} conflicts with another supplied option.`);
    }
    const prior = assigned.get(pathKey);
    if (prior && !spec.repeatable) {
      throw usage(`--${spec.name} may be supplied only once.`);
    }
    const sourceValue =
      spec.representation === "file"
        ? await readInput(rawValue, readers)
        : rawValue;
    const value =
      spec.representation === "json"
        ? parseJson(sourceValue, `--${spec.name}`)
        : parseTypedValue(spec.schema, sourceValue, `--${spec.name}`);
    if (spec.repeatable) {
      const current = getAtPath(input, spec.path);
      if (current === undefined) setAtPath(input, spec.path, [value]);
      else (current as unknown[]).push(value);
    } else {
      setAtPath(input, spec.path, value);
    }
    assigned.set(pathKey, { repeatable: spec.repeatable });
  }
  return { input, json };
}

export function renderDynamicToolHelp(
  tool: AgentToolDescription,
  commandPath: readonly string[],
): string {
  const specs = [...optionSpecs(tool.inputSchema).values()];
  const lines = [
    `Usage: sedes ${commandPath.join(" ")} [options]`,
    "",
    tool.description,
    "",
    `Effects: application=${tool.effects.application}, model=${tool.effects.modelUsage}, external=${tool.effects.external}`,
    "",
    "Options:",
  ];
  if (specs.length === 0) lines.push("  (no input options)");
  for (const spec of specs) {
    const requirement = optionRequirement(tool.inputSchema, spec.path);
    const marker =
      requirement === "required" && hasAlternativeForm(spec, specs)
        ? "required alternative"
        : requirement;
    lines.push(
      `  --${spec.name} <${optionType(spec)}>  ${marker}${optionDescription(spec)}`,
    );
  }
  if (
    tool.inputSchema.minProperties !== undefined &&
    tool.inputSchema.minProperties > tool.inputSchema.required.length
  ) {
    const additional =
      tool.inputSchema.minProperties - tool.inputSchema.required.length;
    lines.push(
      `  Input requires at least ${tool.inputSchema.minProperties} total properties (${additional} additional optional ${additional === 1 ? "field" : "fields"}).`,
    );
  }
  lines.push(
    "  --input-file <PATH|->  Read the complete canonical input object as JSON.",
    "  --json                 Emit a structured failure envelope for a non-completed outcome.",
    "  --help                 Show this live command help without invoking it.",
    "  Required alternatives are mutually exclusive forms of the same input value.",
    "",
  );
  return lines.join("\n");
}

function optionSpecs(
  schema: CanonicalAgentToolRootSchema,
): ReadonlyMap<string, OptionSpec> {
  try {
    return new Map(
      canonicalCliOptionSpecs(schema).map((spec) => [spec.name, spec]),
    );
  } catch {
    throw usage(
      "The live tool schema has ambiguous or reserved named CLI options.",
    );
  }
}

function parseTypedValue(
  schema: CanonicalAgentToolSchema,
  value: string,
  option: string,
): unknown {
  if ("anyOf" in schema) {
    const members = [...schema.anyOf].sort(
      (left, right) => primitiveRank(left) - primitiveRank(right),
    );
    for (const member of members) {
      try {
        return parseTypedValue(member, value, option);
      } catch {}
    }
    throw usage(`${option} has an invalid typed value.`);
  }
  if (schema.type === "string") return value;
  if (schema.type === "integer") {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
      throw usage(`${option} requires a base-10 integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw usage(`${option} requires a safe integer.`);
    }
    return parsed;
  }
  if (schema.type === "number") {
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) {
      throw usage(`${option} requires a finite JSON number.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw usage(`${option} requires a finite JSON number.`);
    }
    return parsed;
  }
  if (schema.type === "boolean") {
    if (value !== "true" && value !== "false") {
      throw usage(`${option} requires explicit true or false.`);
    }
    return value === "true";
  }
  if (schema.type === "null") {
    if (value !== "null") throw usage(`${option} requires null.`);
    return null;
  }
  return parseJson(value, option);
}

function splitOption(argument: string): {
  readonly name: string;
  readonly inlineValue?: string;
} {
  if (!argument.startsWith("--") || argument.length === 2) {
    throw usage("Named Sedes commands accept options only.");
  }
  const separator = argument.indexOf("=");
  const name = argument.slice(2, separator < 0 ? undefined : separator);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw usage("Command option names must use lowercase kebab case.");
  }
  return separator < 0
    ? { name }
    : { name, inlineValue: argument.slice(separator + 1) };
}

function parseJson(value: string, source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    deterministicJson(parsed);
    return parsed;
  } catch {
    throw usage(`${source} must contain valid JSON.`);
  }
}

function parseObjectJson(value: string, source: string): object {
  const parsed = parseJson(value, source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usage(`${source} must contain a JSON object.`);
  }
  return parsed;
}

async function readInput(
  path: string,
  readers: SedesDynamicCliInputReaders,
): Promise<string> {
  try {
    return await (path === "-" ? readers.readStdin() : readers.readFile(path));
  } catch {
    throw usage(
      `Unable to read CLI input from ${path === "-" ? "stdin" : "the selected file"}.`,
    );
  }
}

function getAtPath(root: Record<string, unknown>, path: readonly string[]) {
  let current: unknown = root;
  for (const part of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setAtPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (next === undefined) current[part] = {};
    if (
      typeof current[part] !== "object" ||
      current[part] === null ||
      Array.isArray(current[part])
    ) {
      throw usage("Named CLI options resolve to conflicting input shapes.");
    }
    current = current[part] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function optionType(spec: OptionSpec): string {
  if (spec.representation === "file") return "PATH|-";
  if (spec.representation === "json") return "JSON";
  const enumValues = stringEnumValues(spec.schema);
  if (enumValues) return enumValues.join("|");
  if ("anyOf" in spec.schema) return "typed value";
  return spec.schema.type;
}

function optionDescription(spec: OptionSpec): string {
  const details: string[] = [];
  if (spec.schema.description) details.push(spec.schema.description);
  if (spec.arraySchema?.minItems !== undefined) {
    details.push(`repeat at least ${spec.arraySchema.minItems} times`);
  }
  if (spec.arraySchema?.uniqueItems) details.push("values must be unique");
  return details.length > 0 ? ` — ${details.join("; ")}` : "";
}

type Requirement = "required" | "conditional" | "optional";

interface RequirementState {
  readonly requiredInAll: boolean;
  readonly requiredInSome: boolean;
}

function optionRequirement(
  schema: CanonicalAgentToolRootSchema,
  path: readonly string[],
): Requirement {
  const state = requirementWithinObject(schema, path);
  return state.requiredInAll
    ? "required"
    : state.requiredInSome
      ? "conditional"
      : "optional";
}

function requirementWithinObject(
  schema: Extract<CanonicalAgentToolSchema, { readonly type: "object" }>,
  path: readonly string[],
): RequirementState {
  const [property, ...remaining] = path;
  if (!property) return { requiredInAll: false, requiredInSome: false };
  const child = schema.properties[property];
  if (!child) return { requiredInAll: false, requiredInSome: false };
  const directRequired = schema.required.includes(property);
  if (remaining.length === 0) {
    return {
      requiredInAll: directRequired,
      requiredInSome: directRequired,
    };
  }
  const nested = requirementWithinSchema(child, remaining);
  return {
    requiredInAll: directRequired && nested.requiredInAll,
    requiredInSome: nested.requiredInSome,
  };
}

function requirementWithinSchema(
  schema: CanonicalAgentToolSchema,
  path: readonly string[],
): RequirementState {
  if ("anyOf" in schema) {
    const states = schema.anyOf.map((member) =>
      !("anyOf" in member) && member.type === "object"
        ? requirementWithinObject(member, path)
        : { requiredInAll: false, requiredInSome: false },
    );
    return {
      requiredInAll: states.every((state) => state.requiredInAll),
      requiredInSome: states.some((state) => state.requiredInSome),
    };
  }
  return schema.type === "object"
    ? requirementWithinObject(schema, path)
    : { requiredInAll: false, requiredInSome: false };
}

function hasAlternativeForm(
  spec: OptionSpec,
  specs: readonly OptionSpec[],
): boolean {
  const key = spec.path.join("\u0000");
  return specs.some((candidate) => {
    if (candidate === spec) return false;
    const candidateKey = candidate.path.join("\u0000");
    return (
      candidateKey === key ||
      (candidate.representation === "json" &&
        key.startsWith(`${candidateKey}\u0000`)) ||
      (spec.representation === "json" &&
        candidateKey.startsWith(`${key}\u0000`))
    );
  });
}

function primitiveRank(schema: CanonicalAgentToolSchema): number {
  if ("anyOf" in schema) return 5;
  return {
    null: 0,
    boolean: 1,
    integer: 2,
    number: 3,
    string: 4,
    object: 5,
    array: 5,
  }[schema.type];
}

function stringEnumValues(
  schema: CanonicalAgentToolSchema,
): readonly string[] | undefined {
  if ("anyOf" in schema) {
    const memberValues = schema.anyOf.map(stringEnumValues);
    if (memberValues.some((values) => values === undefined)) return undefined;
    return [...new Set(memberValues.flatMap((values) => values!))];
  }
  return schema.type === "string" ? schema.enum : undefined;
}

function usage(message: string): SedesDynamicCliUsageError {
  return new SedesDynamicCliUsageError(message);
}

function compareWords(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftValue = left.join("\u0000");
  const rightValue = right.join("\u0000");
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
