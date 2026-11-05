import { describe, expect, it } from "vitest";
import { createMockNotificationProvider } from "./mock-provider.js";

const email = {
  idempotencyKey: "0b0f0f0e-0000-4000-8000-000000000001",
  channel: "EMAIL",
  recipient: "buyer@example.com",
  template: "order-confirmation",
} as const;

describe("mock notification provider", () => {
  it("records each delivery", async () => {
    const provider = createMockNotificationProvider();

    await provider.send(email);
    await provider.send({ ...email, idempotencyKey: "other", channel: "SMS", recipient: "+3612" });

    expect(provider.deliveries().map((delivery) => delivery.channel)).toEqual(["EMAIL", "SMS"]);
  });

  it("dedupes by idempotency key", async () => {
    const provider = createMockNotificationProvider();

    await provider.send(email);
    await provider.send(email);

    expect(provider.deliveries()).toHaveLength(1);
  });
});
