import { describe, expect, it } from "vitest";
import { REDACTED, redactLogLine } from "./index";

const EMAIL = "buyer.one+tag@example.com";
const PHONE = "+36 30 123 4567";

function redacted(record: object): Record<string, unknown> {
  return JSON.parse(redactLogLine(`${JSON.stringify(record)}\n`));
}

describe("log redaction policy", () => {
  it("redacts contact fields by key at any depth, including in arrays", () => {
    const line = redacted({
      email: EMAIL,
      contact: { email: EMAIL, phone: PHONE },
      order: { contactEmail: EMAIL, contactPhone: PHONE },
      deliveries: [{ channel: "SMS", recipient: PHONE }],
      buyerEmail: EMAIL,
    });

    expect(line).toEqual({
      email: REDACTED,
      contact: { email: REDACTED, phone: REDACTED },
      order: { contactEmail: REDACTED, contactPhone: REDACTED },
      deliveries: [{ channel: "SMS", recipient: REDACTED }],
      buyerEmail: REDACTED,
    });
  });

  it("redacts an email or phone number embedded in any string, such as an error message or stack", () => {
    const line = redacted({
      err: {
        type: "PrismaClientKnownRequestError",
        message: `Unique constraint failed for contact ${EMAIL} / ${PHONE}`,
        stack: `PrismaClientKnownRequestError: ${EMAIL} (555) 123-4567\n    at handler (file.ts:12:5)`,
      },
    });

    const text = JSON.stringify(line);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain("123-4567");
    expect(line["err"]).toMatchObject({ type: "PrismaClientKnownRequestError" });
    expect(text).toContain("at handler (file.ts:12:5)");
  });

  it("keeps ids, timestamps, addresses and numbers intact", () => {
    const record = {
      correlationId: "0b8e4a8c-2f43-4f0e-9d7a-3c1e5b6f7a80",
      causationId: "12345678-1234-4234-8234-a23456789012",
      messageId: "4f1c2d3e-0000-4000-8000-000000000000",
      occurredAt: "2026-11-26T20:09:00.000Z",
      msg: "connect ECONNREFUSED 127.0.0.1:4222 after 30000 ms",
      deliveryCount: 3,
      time: 1795200000000,
    };

    expect(redacted(record)).toEqual(record);
  });

  it("redacts contact details even in a line that is not JSON", () => {
    const line = redactLogLine(`plain text for ${EMAIL} at ${PHONE}\n`);

    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain(PHONE);
    expect(line.endsWith("\n")).toBe(true);
  });
});
