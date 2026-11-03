import type { Logger } from "@ticketarena/contracts";
import pino, { type DestinationStream } from "pino";

/** The one place web builds a pino logger; packages only ever receive it injected. */
export function createWebLogger(destination?: DestinationStream): Logger {
  return destination === undefined ? pino({ name: "web" }) : pino({ name: "web" }, destination);
}
