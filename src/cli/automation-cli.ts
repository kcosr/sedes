#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  automationCliInputSchema,
  type AutomationCliInput,
} from "./automation-input.js";
import {
  SedesCliApiClient,
  SedesCliApiError,
  normalizeSedesUrl,
} from "./sedes-api-client.js";
import { SEDES_VERSION } from "../shared/version.js";
import {
  automationRunFilterSchema,
  type AutomationRunFilter,
} from "../shared/protocol/domain.js";

const usage = `Sedes automation CLI

Usage:
  npm run automation -- validate FILE
  npm run automation -- create THREAD_ID FILE [--mutation-id UUID]
  npm run automation -- update AUTOMATION_ID FILE
  npm run automation -- preview THREAD_ID FILE
  npm run automation -- precheck THREAD_ID FILE
  npm run automation -- get AUTOMATION_ID
  npm run automation -- enable AUTOMATION_ID
  npm run automation -- pause AUTOMATION_ID
  npm run automation -- run-now AUTOMATION_ID
  npm run automation -- runs AUTOMATION_ID [--filter all|problems|skipped]
  npm run automation -- resolve AUTOMATION_ID RUN_ID [--resume]
  npm run automation -- list [QUERY] [--thread THREAD_ID]
  npm run automation -- remove AUTOMATION_ID

Options:
  --server URL       Sedes origin (default: SEDES_URL or http://127.0.0.1:4784)
  --allow-remote     Permit an explicitly trusted non-loopback Sedes origin
  --filter FILTER    runs: all (default), problems (failed, uncertain or failed turn), or skipped
  --resume           resolve: also enable the automation in the same operation
  --thread ID        list: restrict results to an existing source thread
  --mutation-id UUID create/run-now: reuse this key when retrying the same request
  --help             Show this help
  --version          Print this build's Sedes version

Authentication: set SEDES_AUTH_TOKEN to this server's paired device credential.

Create attaches an independent automation to an existing thread or draft.
Create and run-now print their mutation key before sending the request. Reuse
that key with unchanged input after an uncertain result; a new key means new work.
All item commands use an automation ID, not its source thread ID.
`;

interface CliOptions {
  readonly commandArguments: string[];
  readonly server: string;
  readonly allowRemote: boolean;
  readonly filter?: AutomationRunFilter;
  readonly resume: boolean;
  readonly threadId?: string;
  readonly mutationId?: string;
}

function parseOptions(arguments_: string[]): CliOptions {
  const commandArguments: string[] = [];
  let server = process.env.SEDES_URL ?? "http://127.0.0.1:4784";
  let allowRemote = false;
  let filter: AutomationRunFilter | undefined;
  let resume = false;
  let threadId: string | undefined;
  let mutationId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--server") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--server requires a URL.");
      server = value;
      index += 1;
    } else if (argument === "--allow-remote") {
      allowRemote = true;
    } else if (argument === "--filter") {
      const value = automationRunFilterSchema.safeParse(arguments_[index + 1]);
      if (!value.success) {
        throw new Error("--filter requires all, problems, or skipped.");
      }
      filter = value.data;
      index += 1;
    } else if (argument === "--thread" || argument === "--mutation-id") {
      const value = z.uuid().safeParse(arguments_[index + 1]);
      if (!value.success) throw new Error(`${argument} requires a UUID.`);
      if (argument === "--thread") threadId = value.data;
      else mutationId = value.data;
      index += 1;
    } else if (argument === "--resume") {
      resume = true;
    } else if (argument === "--help" || argument === "-h") {
      commandArguments.push("help");
    } else if (argument === "--version" || argument === "-v") {
      commandArguments.push("version");
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      commandArguments.push(argument);
    }
  }
  return {
    commandArguments,
    server,
    allowRemote,
    ...(filter ? { filter } : {}),
    resume,
    ...(threadId ? { threadId } : {}),
    ...(mutationId ? { mutationId } : {}),
  };
}

async function readInput(path: string): Promise<AutomationCliInput> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 256 * 1024) {
    throw new Error("Automation input must be at most 256 KiB.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return automationCliInputSchema.parse(raw);
}

function requireArguments(
  values: string[],
  count: number,
  synopsis: string,
): string[] {
  if (values.length !== count || values.some((value) => value.length === 0)) {
    throw new Error(`Usage: npm run automation -- ${synopsis}`);
  }
  return values;
}

async function runChecks(
  client: SedesCliApiClient,
  threadId: string,
  input: AutomationCliInput,
) {
  const schedulePreview =
    input.checks.previewCount > 0
      ? await client.previewAutomation(
          threadId,
          input.automation,
          input.checks.previewCount,
        )
      : undefined;
  const precheckTest = input.checks.testPrecheck
    ? await client.testPrecheck(threadId, input.automation)
    : undefined;
  return { schedulePreview, precheckTest };
}

async function applyDesiredState(
  client: SedesCliApiClient,
  automationId: string,
  automation: Awaited<ReturnType<SedesCliApiClient["getAutomation"]>>,
  desiredState: "enabled" | "paused",
) {
  if (automation.status === desiredState) return automation;
  return client.setAutomationState(
    automationId,
    desiredState === "enabled" ? "enable" : "pause",
    automation.revision,
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [command, ...arguments_] = options.commandArguments;
  if (options.filter && command !== "runs") {
    throw new Error("--filter applies only to runs.");
  }
  if (options.resume && command !== "resolve") {
    throw new Error("--resume applies only to resolve.");
  }
  if (options.threadId && command !== "list") throw new Error("--thread applies only to list.");
  if (options.mutationId && command !== "create" && command !== "run-now") {
    throw new Error("--mutation-id applies only to create and run-now.");
  }
  if (command === "version") {
    process.stdout.write(`sedes ${SEDES_VERSION}\n`);
    return;
  }
  if (!command || command === "help") {
    process.stdout.write(usage);
    return;
  }

  if (command === "validate") {
    const [path] = requireArguments(arguments_, 1, "validate FILE");
    print({ valid: true, input: await readInput(path!) });
    return;
  }

  const baseUrl = normalizeSedesUrl(options.server, options.allowRemote);
  const client = new SedesCliApiClient(baseUrl, process.env.SEDES_AUTH_TOKEN);

  if (command === "create") {
    const [threadId, path] = requireArguments(arguments_, 2, "create THREAD_ID FILE");
    const input = await readInput(path!);
    const checks = await runChecks(client, threadId!, input);
    const mutationId = options.mutationId ?? crypto.randomUUID();
    process.stderr.write(`Mutation ID: ${mutationId}\n`);
    const automation = await client.createAutomation(threadId!, input.automation, mutationId);
    print({ mutationId, automation, ...checks });
    return;
  }

  if (command === "update") {
    const [automationId, path] = requireArguments(arguments_, 2, "update AUTOMATION_ID FILE");
    const input = await readInput(path!);
    if (input.automation.initialState !== undefined) {
      throw new Error("initialState applies only to create; use enable or pause to change state.");
    }
    const current = await client.getAutomation(automationId!);
    const checks = await runChecks(client, current.threadId, input);
    const automation = await client.updateAutomation(automationId!, input.automation, current.revision);
    print({ automation, ...checks });
    return;
  }

  if (command === "preview" || command === "precheck") {
    const [threadId, path] = requireArguments(
      arguments_,
      2,
      `${command} THREAD_ID FILE`,
    );
    const input = await readInput(path!);
    print(
      command === "preview"
        ? await client.previewAutomation(
            threadId!,
            input.automation,
            input.checks.previewCount || 5,
          )
        : await client.testPrecheck(threadId!, input.automation),
    );
    return;
  }

  if (command === "get") {
    const [automationId] = requireArguments(arguments_, 1, "get AUTOMATION_ID");
    print(await client.getAutomation(automationId!));
    return;
  }

  if (command === "enable" || command === "pause") {
    const [automationId] = requireArguments(arguments_, 1, `${command} AUTOMATION_ID`);
    const current = await client.getAutomation(automationId!);
    print(
      await applyDesiredState(
        client,
        automationId!,
        current,
        command === "enable" ? "enabled" : "paused",
      ),
    );
    return;
  }

  if (command === "run-now") {
    const [automationId] = requireArguments(arguments_, 1, "run-now AUTOMATION_ID");
    const mutationId = options.mutationId ?? crypto.randomUUID();
    process.stderr.write(`Mutation ID: ${mutationId}\n`);
    print({ mutationId, run: await client.runNow(automationId!, mutationId) });
    return;
  }

  if (command === "runs") {
    const [automationId] = requireArguments(
      arguments_,
      1,
      "runs AUTOMATION_ID [--filter all|problems|skipped]",
    );
    print(await client.listRuns(automationId!, options.filter));
    return;
  }

  if (command === "resolve") {
    const [automationId, runId] = requireArguments(
      arguments_,
      2,
      "resolve AUTOMATION_ID RUN_ID [--resume]",
    );
    print(await client.resolveRun(automationId!, runId!, options.resume));
    return;
  }

  if (command === "remove") {
    const [automationId] = requireArguments(arguments_, 1, "remove AUTOMATION_ID");
    const current = await client.getAutomation(automationId!);
    print(await client.deleteAutomation(automationId!, current.revision));
    return;
  }

  if (command === "list") {
    if (arguments_.length > 1)
      throw new Error("Usage: npm run automation -- list [QUERY]");
    const query = arguments_[0]?.toLocaleLowerCase();
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await client.listAutomations({
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items.filter((automation) =>
        !query || automation.name.toLocaleLowerCase().includes(query) ||
          automation.source.title.toLocaleLowerCase().includes(query),
      ));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    print({ items });
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof SedesCliApiError) {
    process.stderr.write(
      `${error.code}: ${error.message} (HTTP ${error.status}, retryable=${error.retryable})\n`,
    );
  } else if (error instanceof z.ZodError) {
    process.stderr.write(`${z.prettifyError(error)}\n`);
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
