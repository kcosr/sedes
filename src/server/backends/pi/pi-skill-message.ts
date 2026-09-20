import type { BackendItem } from "../../../shared/protocol/backend.js";
import {
  boundDisplayText,
  preserveMessageText,
} from "../../conversations/payload-policy.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import { projectAuthenticatedPiContextExcerpts } from "./pi-context-excerpt-message.js";
import type { MaterializedTaskContext } from "../../../shared/protocol/tasks.js";
import { projectAuthenticatedPiTaskContexts } from "./pi-task-context-message.js";
import { inspectStagedAttachmentManifest } from "../staged-attachment-manifest.js";

type BackendUserMessageContent = Extract<
  BackendItem,
  { semanticKind: "user_message" }
>["content"];

const piSkillInvocationPattern =
  /^<skill name="([^"\r\n]{1,160})" location="[^"\r\n]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

interface ParsedPiSkillInvocation {
  readonly name?: string;
  readonly userText: string;
}

export function parsePiSkillInvocation(
  value: string,
): ParsedPiSkillInvocation | undefined {
  const match = piSkillInvocationPattern.exec(value);
  if (!match) return undefined;
  return {
    name: match[1]!,
    userText: match[2] ?? "",
  };
}

/**
 * Pi owns the expanded skill envelope, so an envelope-shaped value must never
 * cross to the browser verbatim. This deliberately prefers omitting malformed
 * provider content over exposing a native path or the injected skill body.
 */
function redactMalformedPiSkillInvocation(
  value: string,
): ParsedPiSkillInvocation | undefined {
  if (!value.startsWith("<skill ")) return undefined;
  const openingEnd = value.indexOf(">");
  const opening = openingEnd < 0 ? value : value.slice(0, openingEnd + 1);
  const name = /\bname="([^"\r\n]{1,160})"/u.exec(opening)?.[1];
  const closingStart = value.lastIndexOf("</skill>");
  if (closingStart < 0) return { ...(name ? { name } : {}), userText: "" };
  const suffix = value.slice(closingStart + "</skill>".length);
  return {
    ...(name ? { name } : {}),
    userText: suffix.replace(/^(?:\r?\n){1,2}/u, ""),
  };
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Projects Pi's provider-native expanded skill prompt into browser-safe parts.
 * The skill body and provider path remain private; only the normalized name and
 * the user's additional instructions cross the backend boundary.
 */
export function projectPiUserMessageContent(
  value: unknown,
  authenticatedContextExcerpts: readonly ContextExcerpt[] = [],
  stagedAttachmentAuthentication?: {
    readonly key: Uint8Array;
    readonly correlation: string;
  },
  authenticatedTaskContexts: readonly MaterializedTaskContext[] = [],
): BackendUserMessageContent {
  const rawTextParts: string[] = [];
  if (typeof value === "string") {
    rawTextParts.push(value);
  } else if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const part =
        descriptor && "value" in descriptor ? descriptor.value : undefined;
      const text = own(part, "text");
      if (own(part, "type") === "text" && typeof text === "string") {
        rawTextParts.push(text);
      }
    }
  }

  let skillName: string | undefined;
  const visibleTextParts = rawTextParts.map((text) => {
    const invocation =
      parsePiSkillInvocation(text) ?? redactMalformedPiSkillInvocation(text);
    if (!invocation) return text;
    if (invocation.name) skillName ??= invocation.name;
    return invocation.userText;
  });
  let providerVisibleText = visibleTextParts.join("");
  const attachmentContent: BackendUserMessageContent = [];
  if (
    providerVisibleText.startsWith("<sedes-staged-attachments") ||
    providerVisibleText.startsWith("<harness-staged-attachments")
  ) {
    const lines = providerVisibleText.split("\n");
    const carrier = lines.slice(0, 4).join("\n");
    const inspection = stagedAttachmentAuthentication
      ? inspectStagedAttachmentManifest(
          carrier,
          {
            key: stagedAttachmentAuthentication.key,
            correlation: stagedAttachmentAuthentication.correlation,
          },
          { acceptLegacyHarness: true },
        )
      : ({ type: "invalid" } as const);
    if (inspection.type === "authenticated") {
      attachmentContent.push(
        ...inspection.attachments.map((attachment) => ({
          kind: "attachment" as const,
          attachment,
        })),
      );
    }
    // Provider-private paths are removed even when a provider mutates the
    // carrier. Only an authenticated carrier is promoted to attachment cards.
    providerVisibleText = lines.slice(4).join("\n");
  }
  const tasks = projectAuthenticatedPiTaskContexts(
    providerVisibleText,
    authenticatedTaskContexts,
  );
  const context = projectAuthenticatedPiContextExcerpts(
    tasks.userText,
    authenticatedContextExcerpts,
  );
  const visibleText = context.userText;
  const text = preserveMessageText(visibleText);

  const content: BackendUserMessageContent = [];
  if (skillName) {
    content.push({ kind: "skill", name: boundDisplayText(skillName) });
  }
  content.push(...attachmentContent);
  content.push(...tasks.content);
  content.push(...context.content);
  if (
    visibleText.length > 0 ||
    (!skillName && context.content.length === 0 && tasks.content.length === 0)
  ) {
    content.push({ kind: "text", text });
  }
  return content;
}
