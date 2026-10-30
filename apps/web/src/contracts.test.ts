import { envelopeSchema, seatHeldPayloadSchema } from "@ticketarena/contracts";
import { describe, expect, it } from "vitest";

const holdId = "7b0f3c1e-5a52-4f7e-9d0e-0d6f3c9a1b11";
const eventId = "2f6c1a43-8f5e-4b53-a0a5-6a4b9d2f7c10";
const seatId = "c1d7f4a2-3b9e-4c55-8e21-9f0a6b7d5e33";

const heldEnvelope = {
  id: "0e9a5c52-71a4-4d0a-bb2c-3f1d8a6e4c77",
  type: "seat.held",
  version: 1,
  occurredAt: "2026-10-30T12:00:00.000Z",
  correlationId: "a4b8e0d1-6c23-4f19-9a7b-5e3d2c1f0b88",
  causationId: null,
  holdId,
  payload: {
    holdId,
    eventId,
    seatIds: [seatId],
    holdExpiresAt: "2026-10-30T12:10:00.000Z",
  },
};

describe("event envelope", () => {
  const seatHeldEnvelope = envelopeSchema(seatHeldPayloadSchema);

  it("accepts a seat.held envelope with a null causationId and no orderId", () => {
    const parsed = seatHeldEnvelope.parse(heldEnvelope);

    expect(parsed.correlationId).toBe(heldEnvelope.correlationId);
    expect(parsed.causationId).toBeNull();
    expect(parsed.payload.seatIds).toEqual([seatId]);
  });

  it("rejects an envelope without a correlationId, naming the field", () => {
    const { correlationId: _omitted, ...withoutCorrelation } = heldEnvelope;

    const result = seatHeldEnvelope.safeParse(withoutCorrelation);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain("correlationId");
  });

  it("rejects an occurredAt that is not an ISO-8601 UTC timestamp", () => {
    const result = seatHeldEnvelope.safeParse({
      ...heldEnvelope,
      occurredAt: "yesterday",
    });

    expect(result.success).toBe(false);
  });
});

describe("seat.held payload", () => {
  it("rejects an empty seatIds list", () => {
    const result = seatHeldPayloadSchema.safeParse({
      ...heldEnvelope.payload,
      seatIds: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a payload without holdExpiresAt", () => {
    const { holdExpiresAt: _omitted, ...withoutExpiry } = heldEnvelope.payload;

    expect(seatHeldPayloadSchema.safeParse(withoutExpiry).success).toBe(false);
  });
});
