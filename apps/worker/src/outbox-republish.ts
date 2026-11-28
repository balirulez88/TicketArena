import { parseArgs } from "node:util";
import { RETENTION_MS } from "@ticketarena/messaging";
import { z } from "zod";

const republishSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  service: z.enum(["booking", "payment", "notification"]),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  operator: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

export interface RepublishCommand {
  readonly databaseUrl: string;
  readonly service: "booking" | "payment" | "notification";
  readonly publishedFrom: Date;
  readonly publishedTo: Date;
  readonly operator: string;
  readonly reason: string;
}

/**
 * Validates `outbox:republish --service <booking|payment|notification> --from <ISO time>
 * --to <ISO time> --operator <name> --reason <text>` and its `DATABASE_URL`, naming every bad
 * field at once. The range is on `publishedAt`, `from` inclusive and `to` exclusive.
 *
 * `from` must lie in the replay window, no earlier than `now` minus the 14-day retention: only
 * there are consumers guaranteed to still hold the `processed_messages` rows that deduplicate a
 * re-published event. A row with history outlives the retention for its audit, not for replay.
 */
export function parseRepublishCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
): RepublishCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      service: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
  });
  const result = republishSchema.safeParse({ ...values, DATABASE_URL: env["DATABASE_URL"] });
  if (!result.success) {
    throw new Error(
      `Usage: outbox:republish --service <booking|payment|notification> --from <ISO time> --to <ISO time> --operator <name> --reason <text>\n${z.prettifyError(result.error)}`,
    );
  }
  const publishedFrom = new Date(result.data.from);
  const windowStart = new Date(now.getTime() - RETENTION_MS);
  if (publishedFrom.getTime() < windowStart.getTime()) {
    throw new Error(
      `--from ${publishedFrom.toISOString()} is before the supported replay window, which starts at ${windowStart.toISOString()} (14 days ago): consumers' processed_messages rows for older events may be deleted, so a replay could apply them twice. Pass --from ${windowStart.toISOString()} or later; older events cannot be recovered automatically (docs/messaging/consumer-recovery.md, "The 14-day limit").`,
    );
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    service: result.data.service,
    publishedFrom,
    publishedTo: new Date(result.data.to),
    operator: result.data.operator,
    reason: result.data.reason,
  };
}
