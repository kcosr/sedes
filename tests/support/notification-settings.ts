import { defaultNotificationDelivery, type NotificationDelivery, type NotificationEventKind } from "../../src/shared/protocol/notification.js";

/** Explicit script selection for tests; production accepts only the complete delivery map. */
export function scriptDelivery(events: readonly NotificationEventKind[]): NotificationDelivery {
  const delivery = defaultNotificationDelivery();
  for (const event of events) delivery[event].script = true;
  return delivery;
}
