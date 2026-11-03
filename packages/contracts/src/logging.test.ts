import { describe, expect, it } from "vitest";
import { causedBy, envelopeLogBindings } from "./logging";

const ids = {
  correlationId: crypto.randomUUID(),
  causationId: crypto.randomUUID(),
  holdId: crypto.randomUUID(),
};

describe("envelopeLogBindings", () => {
  it("carries the envelope ids that are known and omits the rest", () => {
    expect(envelopeLogBindings(ids)).toEqual(ids);
  });

  it("adds orderId and paymentId when known", () => {
    const orderId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    expect(envelopeLogBindings({ ...ids, orderId, paymentId })).toEqual({
      ...ids,
      orderId,
      paymentId,
    });
  });
});

describe("causedBy", () => {
  it("keeps the correlationId and points causationId at the handled message", () => {
    const message = { id: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    expect(causedBy(message)).toEqual({
      correlationId: message.correlationId,
      causationId: message.id,
    });
  });
});
