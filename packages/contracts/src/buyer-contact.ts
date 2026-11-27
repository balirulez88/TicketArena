import { z } from "zod";

/**
 * The buyer contact the checkout accepts. The log redaction policy (`log-redaction.ts`) masks
 * every phone and email this schema lets through, so the two are kept together: a format added
 * here must stay masked by `redactLogLine` (the table test in `log-redaction.test.ts` runs every
 * accepted format through both).
 */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
const MAX_PHONE_LENGTH = 32;

// An optional + and opening parenthesis, then digits separated by spaces, dots, dashes or
// parentheses.
const PHONE_SHAPE = /^\+?\(?\d[\d ().-]*$/;

/**
 * Four dot-separated groups of 1 to 3 digits read as an IPv4 address, which logs must keep to be
 * useful. The redactor leaves that shape alone, so the checkout refuses a phone that starts with
 * it: no accepted phone can slip past the redactor as an address.
 */
export const IPV4_LEAD = String.raw`\+?\(?\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)`;
const IPV4_PREFIX = new RegExp(`^${IPV4_LEAD}`);

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

const contactPhoneSchema = z
  .string()
  .trim()
  .max(MAX_PHONE_LENGTH)
  .refine(
    (value) =>
      PHONE_SHAPE.test(value) &&
      !IPV4_PREFIX.test(value) &&
      digitCount(value) >= MIN_PHONE_DIGITS &&
      digitCount(value) <= MAX_PHONE_DIGITS,
    {
      error: `phone must be ${MIN_PHONE_DIGITS} to ${MAX_PHONE_DIGITS} digits, optionally starting with + or (, separated by spaces, dots, dashes or parentheses`,
    },
  );

export const buyerContactSchema = z.object({
  email: z.email(),
  phone: contactPhoneSchema.optional(),
});
