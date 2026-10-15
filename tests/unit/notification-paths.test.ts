import { expect, it } from "vitest";
import {
  defaultNotificationDelivery,
  notificationSettingsSchema,
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
} from "../../src/shared/protocol/notification.js";

function settings(scriptPath: string) {
  const delivery = defaultNotificationDelivery();
  delivery["turn.completed"].script = true;
  return {
    enabled: true,
    scriptPath,
    arguments: [],
    timeoutSeconds: 10,
    assistantResultPhases: [],
    delivery,
  };
}

it.each([
  "/usr/local/bin/notify",
  "/usr/local/../bin/notify",
  String.raw`C:\Program Files\nodejs\node.exe`,
  String.raw`\\server\tools\notify.exe`,
])("accepts absolute notification executables across server path platforms: %s", (scriptPath) => {
  const configuration = settings(scriptPath);
  expect(notificationSettingsSchema.safeParse({ ...configuration, revision: 0, silenced: false }).success).toBe(true);
  expect(updateNotificationSettingsRequestSchema.safeParse({ ...configuration, expectedRevision: 0 }).success).toBe(true);
  expect(testNotificationRequestSchema.safeParse({ scriptPath, arguments: [], timeoutSeconds: 10 }).success).toBe(true);
});

it.each([
  "notify.exe",
  String.raw`C:notify.exe`,
  String.raw`\tools\notify.exe`,
  String.raw`\\?\C:\tools\notify.exe`,
  String.raw`C:\tools\notify.exe:stream`,
  String.raw`C:\tools\..\notify.exe`,
  "/usr/bin/notify\0",
])("rejects ambiguous or relative notification executables: %s", (scriptPath) => {
  const configuration = settings(scriptPath);
  expect(notificationSettingsSchema.safeParse({ ...configuration, revision: 0, silenced: false }).success).toBe(false);
  expect(updateNotificationSettingsRequestSchema.safeParse({ ...configuration, expectedRevision: 0 }).success).toBe(false);
  expect(testNotificationRequestSchema.safeParse({ scriptPath, arguments: [], timeoutSeconds: 10 }).success).toBe(false);
});
