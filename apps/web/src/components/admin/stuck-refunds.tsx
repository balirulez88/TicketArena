"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration, formatPrice } from "@/lib/format";
import { useTRPC } from "@/trpc/react";

/** Refund obligations change on the reconciler's 5-minute beat, so a slower poll is enough. */
export const STUCK_REFUNDS_POLL_MS = 5000;

const buttonClass =
  "rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground text-sm disabled:opacity-50";

/**
 * Every refund still owed, oldest first. Only one in `MANUAL_REVIEW` has a retry: the reconciler
 * already retries the others by itself.
 */
export function StuckRefunds() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refunds = useQuery(
    trpc.admin.stuckRefunds.queryOptions(undefined, { refetchInterval: STUCK_REFUNDS_POLL_MS }),
  );
  const retry = useMutation(
    trpc.admin.retryRefund.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.admin.stuckRefunds.queryFilter()),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stuck refunds</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {refunds.isError ? (
          <p role="alert" className="text-destructive text-sm">
            The refunds could not be loaded.
          </p>
        ) : null}
        <Table>
          <TableCaption>Stuck refunds</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Payment</TableHead>
              <TableHead scope="col">Amount</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Re-emits</TableHead>
              <TableHead scope="col">Age</TableHead>
              <TableHead scope="col">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(refunds.data ?? []).map((refund) => (
              <TableRow key={refund.paymentId}>
                <TableCell className="font-mono text-xs">
                  {refund.paymentId}
                  {refund.orphan ? " (orphan)" : ""}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatPrice(refund.amount, refund.currency)}
                </TableCell>
                <TableCell>{refund.status}</TableCell>
                <TableCell className="tabular-nums">{refund.refundAttempts}</TableCell>
                <TableCell className="tabular-nums">{formatDuration(refund.ageMs)}</TableCell>
                <TableCell>
                  {refund.status === "MANUAL_REVIEW" ? (
                    <button
                      type="button"
                      className={buttonClass}
                      aria-label={`Retry refund ${refund.paymentId}`}
                      disabled={retry.isPending}
                      onClick={() => retry.mutate({ paymentId: refund.paymentId })}
                    >
                      Retry refund
                    </button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {refunds.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">No refund is waiting.</p>
        ) : null}
        {retry.data === undefined ? null : (
          <p role="status" aria-label="Refund retry result">
            Refund for payment {retry.data.paymentId} requested again.
          </p>
        )}
        {retry.error === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {retry.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
