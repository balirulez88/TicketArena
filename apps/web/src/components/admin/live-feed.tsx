"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
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
import type { AdminFeedPage } from "@/server/routers/admin";
import { useTRPC } from "@/trpc/react";

/** How often the feed asks for what came after its cursor. */
export const FEED_POLL_MS = 1000;

const FEED_PAGE_SIZE = 100;

/** The browser keeps only the newest entries; the outboxes are the full record. */
const MAX_FEED_ENTRIES = 300;

type FeedEntry = AdminFeedPage["entries"][number];
type FeedCursor = NonNullable<AdminFeedPage["nextCursor"]>;

function FeedTable({
  caption,
  entries,
}: {
  readonly caption: string;
  readonly entries: readonly FeedEntry[];
}) {
  return (
    <Table>
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Time</TableHead>
          <TableHead scope="col">Event</TableHead>
          <TableHead scope="col">Service</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Correlation id</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={`${entry.service}:${entry.id}`}>
            <TableCell className="tabular-nums">
              {entry.createdAt.toLocaleTimeString("en-GB")}
            </TableCell>
            <TableCell>{entry.eventType}</TableCell>
            <TableCell>{entry.service}</TableCell>
            <TableCell className={entry.status === "FAILED" ? "text-destructive" : undefined}>
              {entry.status}
            </TableCell>
            <TableCell className="font-mono text-xs">{entry.correlationId ?? "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Groups in order of each saga's first entry, entries in feed order within a group. */
function bySaga(entries: readonly FeedEntry[]): [string, FeedEntry[]][] {
  const groups = new Map<string, FeedEntry[]>();
  for (const entry of entries) {
    const key = entry.correlationId ?? "none";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups];
}

/**
 * The outbox event log as it grows: the first poll reads the newest entries, each later one only
 * what came after the last cursor, so a poll costs one indexed page however long the log is.
 */
export function LiveFeed() {
  const trpc = useTRPC();
  const groupId = useId();
  const [cursor, setCursor] = useState<FeedCursor | undefined>(undefined);
  const [entries, setEntries] = useState<readonly FeedEntry[]>([]);
  const [grouped, setGrouped] = useState(false);
  const page = useQuery(
    trpc.admin.feed.queryOptions(
      cursor === undefined ? { limit: FEED_PAGE_SIZE } : { cursor, limit: FEED_PAGE_SIZE },
      { refetchInterval: FEED_POLL_MS },
    ),
  );

  useEffect(() => {
    const data = page.data;
    if (data === undefined) {
      return;
    }
    if (data.entries.length > 0) {
      setEntries((shown) => {
        const seen = new Set(shown.map((entry) => `${entry.service}:${entry.id}`));
        const added = data.entries.filter((entry) => !seen.has(`${entry.service}:${entry.id}`));
        return [...shown, ...added].slice(-MAX_FEED_ENTRIES);
      });
    }
    const next = data.nextCursor;
    if (
      next !== null &&
      (next.id !== cursor?.id || next.createdAt.getTime() !== cursor.createdAt.getTime())
    ) {
      setCursor(next);
    }
  }, [page.data, cursor]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live feed</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <input
            id={groupId}
            type="checkbox"
            checked={grouped}
            onChange={(change) => setGrouped(change.target.checked)}
          />
          <label htmlFor={groupId}>Group by correlation id</label>
        </div>
        {page.isError ? (
          <p role="alert" className="text-destructive text-sm">
            The feed could not be loaded.
          </p>
        ) : null}
        {grouped ? (
          bySaga(entries).map(([correlationId, sagaEntries]) => (
            <FeedTable
              key={correlationId}
              caption={`Saga ${correlationId}`}
              entries={sagaEntries}
            />
          ))
        ) : (
          <FeedTable caption="Live event feed" entries={entries} />
        )}
      </CardContent>
    </Card>
  );
}
