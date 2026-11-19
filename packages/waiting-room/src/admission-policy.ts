import type { AdmissionPolicy } from "./ports";

/**
 * MVP policy: `NOT_OPEN` before `queueOpensAt`, `ACTIVE` from `queueOpensAt` (inclusive) to
 * `queueClosesAt` (exclusive), `CLOSED` from then on.
 */
export function createScheduleAdmissionPolicy(): AdmissionPolicy {
  return {
    phase(event, now) {
      const time = now.getTime();
      if (time < event.queueOpensAt.getTime()) {
        return "NOT_OPEN";
      }
      return time < event.queueClosesAt.getTime() ? "ACTIVE" : "CLOSED";
    },
  };
}
