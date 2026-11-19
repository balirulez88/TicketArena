"use client";

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { z } from "zod";
import { useTRPC } from "@/trpc/react";
import { checkoutFailure } from "./checkout-failure";

const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
/** The API accepts at most 32 characters for a phone number. */
const MAX_PHONE_LENGTH = 32;
const PHONE_SHAPE = /^\+?[0-9][0-9 ()-]*$/;

function isPhone(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "").length;
  return (
    value.length <= MAX_PHONE_LENGTH &&
    PHONE_SHAPE.test(value) &&
    digits >= MIN_PHONE_DIGITS &&
    digits <= MAX_PHONE_DIGITS
  );
}

/**
 * The checkout form's input as typed. An empty phone means "no phone", so it is left out of the
 * contact rather than sent as an empty string the API would refuse.
 */
export const checkoutFormSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email({ error: "Enter a valid email address." })),
  phone: z
    .string()
    .trim()
    .refine((value) => value === "" || isPhone(value), {
      error: `Enter a valid phone number: ${MIN_PHONE_DIGITS} to ${MAX_PHONE_DIGITS} digits, optionally starting with +.`,
    })
    .transform((value) => (value === "" ? undefined : value)),
});

type Contact = z.output<typeof checkoutFormSchema>;
type FieldErrors = { readonly email?: string; readonly phone?: string };

/** One checkout attempt: the contact it was submitted with and the idempotency key it owns. */
interface Attempt {
  readonly email: string;
  readonly phone: string | undefined;
  readonly idempotencyKey: string;
}

function fieldErrors(error: z.ZodError<z.output<typeof checkoutFormSchema>>): FieldErrors {
  const flat = z.flattenError(error).fieldErrors;
  return {
    ...(flat.email?.[0] === undefined ? {} : { email: flat.email[0] }),
    ...(flat.phone?.[0] === undefined ? {} : { phone: flat.phone[0] }),
  };
}

const inputClass = "rounded-md border px-3 py-2 aria-invalid:border-destructive";

/**
 * Checkout for a live hold: contact details validated with zod, then `booking.placeOrder`.
 *
 * A checkout attempt is this hold plus the contact it is submitted with. Its idempotency key is
 * generated once and reused for every resubmission of the same contact, so a retry after a lost
 * response replays the order the server may already have created instead of placing a second
 * one. Changing the contact starts a new attempt with a new key: reusing the key with a different
 * request would make the server answer `IDEMPOTENCY_KEY_REUSED`. A new hold mounts a new form, so
 * it never inherits an earlier hold's key.
 */
export function CheckoutForm({
  holdId,
  onPlaced,
  onHoldExpired,
}: {
  readonly holdId: string;
  readonly onPlaced: (orderId: string) => void;
  readonly onHoldExpired: () => void;
}) {
  const trpc = useTRPC();
  const ids = useId();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const attempt = useRef<Attempt | null>(null);

  const placeOrder = useMutation(
    trpc.booking.placeOrder.mutationOptions({
      onSuccess: (order) => onPlaced(order.id),
      onError: (error) => {
        const failure = checkoutFailure(error);
        if (failure === "HOLD_EXPIRED") {
          onHoldExpired();
        }
        if (failure === "IDEMPOTENCY_KEY_REUSED") {
          // The key is spent on a different request; the next submit must be a new attempt.
          attempt.current = null;
        }
      },
    }),
  );

  function attemptFor(contact: Contact): Attempt {
    const current = attempt.current;
    if (current !== null && current.email === contact.email && current.phone === contact.phone) {
      return current;
    }
    const next = {
      email: contact.email,
      phone: contact.phone,
      idempotencyKey: crypto.randomUUID(),
    };
    attempt.current = next;
    return next;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = checkoutFormSchema.safeParse({ email, phone });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const contact = parsed.data;
    const { idempotencyKey } = attemptFor(contact);
    placeOrder.mutate({
      holdId,
      contact:
        contact.phone === undefined
          ? { email: contact.email }
          : { email: contact.email, phone: contact.phone },
      idempotencyKey,
    });
  }

  const emailId = `${ids}-email`;
  const phoneId = `${ids}-phone`;
  const failure = placeOrder.isError ? checkoutFailure(placeOrder.error) : null;

  return (
    <form aria-label="Checkout" noValidate className="flex flex-col gap-3" onSubmit={onSubmit}>
      <h3 className="font-semibold text-lg">Checkout</h3>
      <div className="flex flex-col gap-1">
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          className={inputClass}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={errors.email === undefined ? undefined : true}
          aria-describedby={errors.email === undefined ? undefined : `${emailId}-error`}
        />
        {errors.email === undefined ? null : (
          <p id={`${emailId}-error`} className="text-destructive text-sm">
            {errors.email}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={phoneId}>Phone (optional)</label>
        <input
          id={phoneId}
          type="tel"
          autoComplete="tel"
          className={inputClass}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          aria-invalid={errors.phone === undefined ? undefined : true}
          aria-describedby={errors.phone === undefined ? undefined : `${phoneId}-error`}
        />
        {errors.phone === undefined ? null : (
          <p id={`${phoneId}-error`} className="text-destructive text-sm">
            {errors.phone}
          </p>
        )}
      </div>
      <button
        type="submit"
        className="w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        disabled={placeOrder.isPending}
      >
        Place order
      </button>
      {failure === "IDEMPOTENCY_KEY_REUSED" ? (
        <p role="alert" className="text-destructive text-sm">
          This checkout was already submitted with different details, so it was not placed again.
          Check your details and place the order again.
        </p>
      ) : null}
      {failure === "OTHER" ? (
        <p role="alert" className="text-destructive text-sm">
          Your order could not be placed. Please try again.
        </p>
      ) : null}
    </form>
  );
}
