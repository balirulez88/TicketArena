import { type Logger, redactLogLine } from "@ticketarena/contracts";
import type { TRPCError } from "@trpc/server";
import pino, { type DestinationStream, type LoggerOptions } from "pino";

// Redaction runs on the serialized line (docs/architecture "Logging and ids"), so serialized
// errors and child bindings are covered, not only the fields a call site passes.
const options: LoggerOptions = { name: "web", hooks: { streamWrite: redactLogLine } };

/** The one place web builds a pino logger; packages only ever receive it injected. */
export function createWebLogger(destination?: DestinationStream): Logger {
  return destination === undefined ? pino(options) : pino(options, destination);
}

/**
 * The tRPC handler's `onError`: the whole error (stack and cause) goes to the redacting logger,
 * never to `console`, which no redaction policy covers.
 */
export function logProcedureError(logger: Logger) {
  return ({ path, error }: { path: string | undefined; error: TRPCError }): void => {
    logger.error({ err: error, path: path ?? "<no-path>" }, "tRPC procedure failed");
  };
}
