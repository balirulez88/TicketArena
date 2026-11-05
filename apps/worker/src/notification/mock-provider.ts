export type NotificationChannel = "EMAIL" | "SMS";

export interface NotificationMessage {
  readonly idempotencyKey: string;
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly template: string;
}

/** The external delivery boundary. Real providers are at-least-once; callers pass a stable key. */
export interface NotificationProvider {
  send(message: NotificationMessage): Promise<void>;
}

export interface MockNotificationProvider extends NotificationProvider {
  deliveries(): readonly NotificationMessage[];
}

/** Records deliveries and ignores a repeated idempotency key, as a real provider would. */
export function createMockNotificationProvider(): MockNotificationProvider {
  const delivered = new Map<string, NotificationMessage>();
  return {
    async send(message) {
      if (!delivered.has(message.idempotencyKey)) {
        delivered.set(message.idempotencyKey, message);
      }
    },
    deliveries: () => [...delivered.values()],
  };
}
