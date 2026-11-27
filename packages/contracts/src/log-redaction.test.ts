import { describe, expect, it } from "vitest";
import { buyerContactSchema, REDACTED, redactLogLine } from "./index";

const EMAIL = "buyer.one+tag@example.com";
const PHONE = "+36 30 123 4567";

// Every phone format the checkout accepts (`buyerContactSchema`, used by `booking.placeOrder`).
const ACCEPTED_PHONES = [
  "5550109999",
  "555.010.9999",
  "+1.555.010.9999",
  "36.30.123.4567",
  "555 010 9999",
  "+36 30 123 4567",
  "555-010-9999",
  "+1-555-010-9999",
  "555 - 010 - 9999",
  "(555) 010-9999",
  "+1 (555) 010-9999",
  "+(36) 30 123 4567",
  "+(36) 30.123.4567",
  "555-010-9999-",
  "555.010.9999.",
  "+1 555 010 9999",
  "123456789012345",
];

// Every email shape `z.email()` accepts, the checkout's email rule.
const ACCEPTED_EMAILS = [
  "buyer@example.com",
  "buyer.one+tag@example.com",
  "o'brien@example.co.uk",
  "first_last-1@sub-domain.example.io",
  "UPPER.Case@Example.COM",
];

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

  it.each(ACCEPTED_PHONES)("masks the accepted checkout phone %j in free text", (phone) => {
    expect(buyerContactSchema.safeParse({ email: "b@example.com", phone }).success).toBe(true);

    for (const text of [
      `call ${phone} now`,
      `Unique constraint failed (${phone})`,
      `contact=${phone}`,
      `"${phone}"`,
      phone,
    ]) {
      const line = redactLogLine(`${JSON.stringify({ msg: text })}
`);
      expect(line).toContain(REDACTED);
      expect(JSON.parse(line).msg).not.toMatch(/\d/);
    }
  });

  it.each(ACCEPTED_EMAILS)("masks the accepted checkout email %j in free text", (email) => {
    expect(buyerContactSchema.safeParse({ email }).success).toBe(true);

    const line = redactLogLine(`${JSON.stringify({ msg: `mail to ${email}, then retry` })}
`);

    expect(JSON.parse(line).msg).toBe(`mail to ${REDACTED}, then retry`);
  });

  it("refuses a phone shaped like an IPv4 address, which the redactor keeps", () => {
    expect(
      buyerContactSchema.safeParse({ email: "b@example.com", phone: "1.255.010.199" }).success,
    ).toBe(false);
    expect(buyerContactSchema.safeParse({ email: "b@example.com", phone: "call me" }).success).toBe(
      false,
    );
  });

  it("keeps ids, timestamps, addresses and numbers intact", () => {
    const record = {
      correlationId: "0b8e4a8c-2f43-4f0e-9d7a-3c1e5b6f7a80",
      causationId: "12345678-1234-4234-8234-a23456789012",
      messageId: "4f1c2d3e-0000-4000-8000-000000000000",
      occurredAt: "2026-11-26T20:09:00.000Z",
      msg: "connect ECONNREFUSED 127.0.0.1:4222 after 30000 ms",
      peer: "upstream 192.168.100.200:5432 via 10.0.0.1, version 1.2.3",
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
