import { TRPCError } from "@trpc/server";

export function eventNotFound(eventId: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `Event ${eventId} not found` });
}
