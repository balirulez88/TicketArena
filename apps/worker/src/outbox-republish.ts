import { parseArgs } from "node:util";
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
 */
export function parseRepublishCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
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
  return {
    databaseUrl: result.data.DATABASE_URL,
    service: result.data.service,
    publishedFrom: new Date(result.data.from),
    publishedTo: new Date(result.data.to),
    operator: result.data.operator,
    reason: result.data.reason,
  };
}
