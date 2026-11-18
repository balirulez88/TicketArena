import type { AdmissionPolicy } from "./ports";

/** MVP policy: the queue is active from `queueOpensAt` (inclusive) to `queueClosesAt` (exclusive). */
export function createScheduleAdmissionPolicy(): AdmissionPolicy {
  return {
    isQueueActive(event, now) {
      const time = now.getTime();
      return time >= event.queueOpensAt.getTime() && time < event.queueClosesAt.getTime();
    },
  };
}
