import { type Logger, redactLogLine } from "@ticketarena/contracts";
import pino, { type DestinationStream, type LoggerOptions } from "pino";

// Redaction runs on the serialized line (docs/architecture "Logging and ids"), so serialized
// errors and child bindings are covered, not only the fields a call site passes.
const options: LoggerOptions = { name: "worker", hooks: { streamWrite: redactLogLine } };

/** The one place the worker builds a pino logger; packages only ever receive it injected. */
export function createWorkerLogger(destination?: DestinationStream): Logger {
  return destination === undefined ? pino(options) : pino(options, destination);
}
