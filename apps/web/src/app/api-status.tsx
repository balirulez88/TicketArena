"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";

/** Tracer bullet proving the browser -> tRPC -> server path is wired end to end. */
export function ApiStatus() {
  const trpc = useTRPC();
  const health = useQuery(trpc.health.check.queryOptions());

  if (health.isPending) {
    return <p className="text-muted-foreground">Checking API…</p>;
  }
  if (health.isError) {
    return <p className="text-destructive">API unreachable</p>;
  }
  return <p className="text-muted-foreground">API status: {health.data.status}</p>;
}
