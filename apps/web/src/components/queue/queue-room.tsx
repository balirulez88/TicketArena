"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_SELECTED_SEATS } from "@/components/seat-map/seat-selection";
import { formatDateTime } from "@/lib/format";
import { useTRPC } from "@/trpc/react";

/** How often `queue.status` is polled, in the queue room and while admitted (spec: every 3 s). */
export const QUEUE_POLL_MS = 3000;

export type QueuePhase = "OUTSIDE" | "QUEUED" | "ADMITTED";

/**
 * The session's place in the event's waiting room, read from `queue.status`. Polling runs only
 * while the session is queued or admitted: in the queue it moves the buyer on when the ticker
 * admits them, and once admitted every poll is the heartbeat that keeps the slot from being
 * reaped (90 s idle) and re-mints the admission cookie. It keeps running in a background tab for
 * the same reason.
 */
export function useQueueStatus(eventId: string) {
  const trpc = useTRPC();
  const status = useQuery(
    trpc.queue.status.queryOptions(
      { eventId },
      {
        staleTime: 0,
        refetchInterval: (query) => {
          const current = query.state.data?.status;
          return current === "QUEUED" || current === "ADMITTED" ? QUEUE_POLL_MS : false;
        },
        refetchIntervalInBackground: true,
      },
    ),
  );
  const data = status.data;
  const phase: QueuePhase =
    data?.status === "QUEUED" || data?.status === "ADMITTED" ? data.status : "OUTSIDE";
  return { phase, status: data };
}

function formatEta(etaSeconds: number): string {
  if (etaSeconds <= 0) {
    return "any moment now";
  }
  if (etaSeconds < 60) {
    return `about ${etaSeconds} ${etaSeconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.ceil(etaSeconds / 60);
  return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function JoinQueue({ eventId }: { readonly eventId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const join = useMutation(
    trpc.queue.join.mutationOptions({
      onSuccess: async (result) => {
        // Even an immediate admission (ADMISSIBLE, ADMITTED) needs one status poll: that poll is
        // what mints the admission cookie holdSeats checks.
        if (result.status !== "NOT_OPEN") {
          await queryClient.invalidateQueries({
            queryKey: trpc.queue.status.queryKey({ eventId }),
          });
        }
      },
    }),
  );

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        disabled={join.isPending}
        onClick={() => join.mutate({ eventId })}
      >
        Join the queue
      </button>
      {join.data?.status === "NOT_OPEN" ? (
        <p role="status" className="text-muted-foreground text-sm">
          The queue opens{" "}
          <time dateTime={join.data.queueOpensAt.toISOString()}>
            {formatDateTime(join.data.queueOpensAt)}
          </time>
          . Come back then.
        </p>
      ) : null}
      {join.isError ? (
        <p role="alert" className="text-destructive text-sm">
          You could not join the queue. Please try again.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The buyer's way through the waiting room on the event page: a join button, then the queue room
 * (position and ETA) until the ticker admits them, then a note that they may hold seats.
 */
export function QueuePanel({
  eventId,
  queue,
}: {
  readonly eventId: string;
  readonly queue: ReturnType<typeof useQueueStatus>;
}) {
  if (queue.status?.status === "QUEUED") {
    return (
      <section aria-label="Queue room" className="flex flex-col gap-1 rounded-xl border p-4">
        <h2 className="font-semibold text-xl">You are in the queue</h2>
        <p role="status">
          Position {queue.status.position}. Estimated wait: {formatEta(queue.status.etaSeconds)}.
        </p>
        <p className="text-muted-foreground text-sm">
          Keep this page open; it moves you on to the seats when it is your turn.
        </p>
      </section>
    );
  }
  if (queue.phase === "ADMITTED") {
    return (
      <p role="status" aria-label="Admission" className="rounded-xl border p-4">
        It's your turn. Choose up to {MAX_SELECTED_SEATS} seats below and hold them.
      </p>
    );
  }
  return <JoinQueue eventId={eventId} />;
}
