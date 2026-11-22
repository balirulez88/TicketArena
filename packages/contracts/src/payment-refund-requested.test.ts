import { describe, expect, it } from "vitest";
import { paymentRefundRequestedPayloadSchema } from "./payment-refund-requested.js";

const base = {
  paymentId: "6f1c2a4e-8b3d-4c5e-9f60-1a2b3c4d5e6f",
  orderId: "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
  amount: 12_000,
  currency: "EUR",
};

describe("paymentRefundRequestedPayloadSchema", () => {
  it.each([
    "late_capture",
    "late_delivery",
    "order_expired",
    "order_cancelled",
    "order_confirmed",
    "amount_mismatch",
  ])("rejects a %s request without a contact", (reason) => {
    const result = paymentRefundRequestedPayloadSchema.safeParse({ ...base, reason });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["contact"]);
  });

  it("accepts a known-order request with a contact", () => {
    const payload = { ...base, reason: "late_capture", contact: { email: "buyer@example.com" } };

    expect(paymentRefundRequestedPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an unknown_order request without a contact", () => {
    const payload = { ...base, reason: "unknown_order" };

    expect(paymentRefundRequestedPayloadSchema.parse(payload)).toEqual(payload);
  });
});
