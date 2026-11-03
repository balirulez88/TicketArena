import { z } from "zod";
import { type Envelope, envelopeSchema } from "./envelope";

/**
 * The slice of a pino logger the packages use. Apps create the real logger at their boundary and
 * inject it; packages never build one from global state.
 */
export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Discards everything; the default when a caller injects no logger. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

interface EnvelopeIds {
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly holdId?: string | undefined;
  readonly orderId?: string | undefined;
  readonly paymentId?: string | undefined;
}

/** Log bindings that make one booking traceable across web and worker. */
export function envelopeLogBindings(envelope: EnvelopeIds): Record<string, unknown> {
  return {
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    ...(envelope.holdId === undefined ? {} : { holdId: envelope.holdId }),
    ...(envelope.orderId === undefined ? {} : { orderId: envelope.orderId }),
    ...(envelope.paymentId === undefined ? {} : { paymentId: envelope.paymentId }),
  };
}

/**
 * Ids for an event written while handling `cause`: the correlation id never changes and the
 * handled message is the direct cause.
 */
export function causedBy(cause: Pick<Envelope<unknown>, "id" | "correlationId">) {
  return { correlationId: cause.correlationId, causationId: cause.id };
}

const anyEnvelope = envelopeSchema(z.unknown());

/**
 * Bindings for a raw message body. A body that is not a valid envelope still gets logged, just
 * without ids, so a poison message is visible rather than hidden behind a parse failure.
 */
export function logBindingsFor(body: unknown): Record<string, unknown> {
  const parsed = anyEnvelope.safeParse(body);
  return parsed.success ? envelopeLogBindings(parsed.data) : {};
}

/** The envelope in a raw message body, or `undefined` when the body is not a valid one. */
export function parseEnvelope(body: unknown): Envelope<unknown> | undefined {
  const parsed = anyEnvelope.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
