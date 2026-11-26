/**
 * The log redaction policy: buyer contact details (email and phone) never reach a log line. Apps
 * apply `redactLogLine` to every serialized line before it is written (pino's `streamWrite` hook),
 * so it covers bindings, fields and serialized errors alike, whatever logged them.
 *
 * Two rules, because neither alone is enough: a contact field is recognised by its key (the
 * structured case: an order's `contactEmail`, an event's `contact.phone`, a notification's
 * `recipient`), and a contact detail inside free text by its shape (the case TD-048 names: an
 * error message or stack that embeds a query argument). The value rule errs towards
 * over-redaction: any run of 7 or more digits that is not part of an id is treated as a phone.
 */
export const REDACTED = "[Redacted]";

// contactEmail, buyerEmail, e-mail, contactPhone, phoneNumber, recipient (an email or a phone).
const CONTACT_KEY = /e-?mail|phone|recipient/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// 7+ digits with optional +, parentheses, spaces or dashes; never adjacent to a word character or
// dash, so the digit runs inside UUIDs and ISO timestamps are left alone. Dots are not separators,
// so IP addresses and versions survive.
const PHONE_IN_TEXT = /(?<![\w-])\+?\(?\d(?:[\s()-]{0,2}\d){6,}(?![\w-])/g;

function redactText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, REDACTED).replace(PHONE_IN_TEXT, REDACTED);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        CONTACT_KEY.test(key) ? REDACTED : redactValue(field),
      ]),
    );
  }
  return value;
}

/** One serialized log line (JSON plus newline) with every contact detail replaced by `REDACTED`. */
export function redactLogLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON (a pretty-printed or foreign line): the text rule still applies.
    return redactText(line);
  }
  return `${JSON.stringify(redactValue(parsed))}\n`;
}
