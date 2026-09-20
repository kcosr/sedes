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

const usage = `Sedes automation CLI

Usage:
  npm run automation -- validate FILE
  npm run automation -- create FILE
  npm run automation -- update THREAD_ID FILE
  npm run automation -- preview THREAD_ID FILE
  npm run automation -- precheck THREAD_ID FILE
  npm run automation -- get THREAD_ID
  npm run automation -- enable THREAD_ID
  npm run automation -- pause THREAD_ID
  npm run automation -- run-now THREAD_ID
  npm run automation -- runs THREAD_ID
  npm run automation -- list [QUERY]
  npm run automation -- remove THREAD_ID

Options:
  --server URL       Sedes origin (default: SEDES_URL or http://127.0.0.1:4784)
  --allow-remote     Permit an explicitly trusted non-loopback Sedes origin
  --help             Show this help
  --version          Print this build's Sedes version

Authentication: set SEDES_AUTH_TOKEN to this server's paired device credential.

Create is intentionally not an idempotent apply operation: running it twice
creates two threads. Update, state, and removal commands require a thread ID.
`;

interface CliOptions {
  readonly commandArguments: string[];
  readonly server: string;
  readonly allowRemote: boolean;
}

function parseOptions(arguments_: string[]): CliOptions {
  const commandArguments: string[] = [];
  let server = process.env.SEDES_URL ?? "http://127.0.0.1:4784";
  let allowRemote = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--server") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--server requires a URL.");
      server = value;
      index += 1;
    } else if (argument === "--allow-remote") {
      allowRemote = true;
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
  return { commandArguments, server, allowRemote };
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
  threadId: string,
  automation: Awaited<ReturnType<SedesCliApiClient["getAutomation"]>>,
  desiredState: "enabled" | "paused",
) {
  if (automation.status === desiredState) return automation;
  return client.setAutomationState(
    threadId,
    desiredState === "enabled" ? "enable" : "pause",
    automation.revision,
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const [command, ...arguments_] = options.commandArguments;
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
    const [path] = requireArguments(arguments_, 1, "create FILE");
    const input = await readInput(path!);
    if (!input.thread) {
      throw new Error("Create input must include the thread block.");
    }
    const thread = input.thread;
    const snapshot = await client.snapshot();
    const workspace = snapshot.workspaces.find(
      ({ id }) => id === thread.workspaceId,
    );
    if (!workspace) throw new Error(`Unknown workspace: ${thread.workspaceId}`);
    const targetId = thread.configuration.targetId;
    if (!targetId) {
      throw new Error(
        "Automation creation requires an explicit thread target.",
      );
    }
    const target = snapshot.executionTargets.find(
      ({ id }) => id === targetId,
    );
    if (!target?.available) {
      throw new Error(`Unknown or unavailable target: ${targetId}`);
    }
    if (target.environmentId !== workspace.environmentId) {
      throw new Error(
        "The selected target and workspace belong to different execution environments.",
      );
    }

    const threadId = await client.createThread(thread);
    try {
      const snapshot = await client.getThread(threadId);
      if (!snapshot.capabilities.automation.canAttach) {
        throw new Error(
          snapshot.capabilities.automation.unavailableReason?.text ??
            "Automation cannot be attached to the new thread.",
        );
      }
      if (
        input.automation.runMode === "clone" &&
        !snapshot.capabilities.automation.canCloneOnRun
      ) {
        throw new Error(
          "Clone-mode automation is unavailable for the new thread.",
        );
      }
      const checks = await runChecks(client, threadId, input);
      const created = await client.createAutomation(threadId, input.automation);
      const automation = await applyDesiredState(
        client,
        threadId,
        created,
        input.automation.state ?? "paused",
      );
      print({ threadId, automation, ...checks });
    } catch (error) {
      process.stderr.write(
        `Thread ${threadId} was created, but automation setup did not complete.\n`,
      );
      throw error;
    }
    return;
  }

  if (command === "update") {
    const [threadId, path] = requireArguments(
      arguments_,
      2,
      "update THREAD_ID FILE",
    );
    const input = await readInput(path!);
    if (input.thread) {
      throw new Error(
        "Existing-thread commands take the thread ID on the command line; omit the thread block.",
      );
    }
    const snapshot = await client.getThread(threadId!);
    if (
      input.automation.runMode === "clone" &&
      !snapshot.capabilities.automation.canCloneOnRun
    ) {
      throw new Error("Clone-mode automation is unavailable for this thread.");
    }
    const current = await client.getAutomation(threadId!);
    const checks = await runChecks(client, threadId!, input);
    const updated = await client.updateAutomation(
      threadId!,
      input.automation,
      current.revision,
    );
    const automation = await applyDesiredState(
      client,
      threadId!,
      updated,
      input.automation.state ?? updated.status,
    );
    print({ threadId, automation, ...checks });
    return;
  }

  if (command === "preview" || command === "precheck") {
    const [threadId, path] = requireArguments(
      arguments_,
      2,
      `${command} THREAD_ID FILE`,
    );
    const input = await readInput(path!);
    if (input.thread) {
      throw new Error(
        "Existing-thread commands take the thread ID on the command line; omit the thread block.",
      );
    }
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
    const [threadId] = requireArguments(arguments_, 1, "get THREAD_ID");
    print(await client.getAutomation(threadId!));
    return;
  }

  if (command === "enable" || command === "pause") {
    const [threadId] = requireArguments(arguments_, 1, `${command} THREAD_ID`);
    const current = await client.getAutomation(threadId!);
    print(
      await applyDesiredState(
        client,
        threadId!,
        current,
        command === "enable" ? "enabled" : "paused",
      ),
    );
    return;
  }

  if (command === "run-now") {
    const [threadId] = requireArguments(arguments_, 1, "run-now THREAD_ID");
    print(await client.runNow(threadId!));
    return;
  }

  if (command === "runs") {
    const [threadId] = requireArguments(arguments_, 1, "runs THREAD_ID");
    print(await client.listRuns(threadId!));
    return;
  }

  if (command === "remove") {
    const [threadId] = requireArguments(arguments_, 1, "remove THREAD_ID");
    const current = await client.getAutomation(threadId!);
    print(await client.deleteAutomation(threadId!, current.revision));
    return;
  }

  if (command === "list") {
    if (arguments_.length > 1)
      throw new Error("Usage: npm run automation -- list [QUERY]");
    const query = arguments_[0]?.toLocaleLowerCase();
    const snapshot = await client.snapshot();
    const automations = snapshot.threads.filter(
      (thread) =>
        thread.automation !== null &&
        (!query || thread.title.text.toLocaleLowerCase().includes(query)),
    );
    print({
      items: automations,
      boundedToSnapshot: true,
      totalLoadedThreads: snapshot.threads.length,
    });
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
