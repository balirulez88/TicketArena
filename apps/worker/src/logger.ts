import type { Logger } from "@ticketarena/contracts";
import pino, { type DestinationStream } from "pino";

/** The one place the worker builds a pino logger; packages only ever receive it injected. */
export function createWorkerLogger(destination?: DestinationStream): Logger {
  return destination === undefined
    ? pino({ name: "worker" })
    : pino({ name: "worker" }, destination);
}
