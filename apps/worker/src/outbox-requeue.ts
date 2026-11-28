import { parseArgs } from "node:util";
import { z } from "zod";

const requeueSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  service: z.enum(["booking", "payment", "notification"]),
  id: z.uuid(),
  operator: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

export interface RequeueCommand {
  readonly databaseUrl: string;
  readonly service: "booking" | "payment" | "notification";
  readonly outboxId: string;
  readonly operator: string;
  readonly reason: string;
}

/**
 * Validates `outbox:requeue --service <booking|payment|notification> --id <outbox id>
 * --operator <name> --reason <text>` and its `DATABASE_URL`, naming every bad field at once.
 */
export function parseRequeueCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): RequeueCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      service: { type: "string" },
      id: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
    },
    strict: true,
  });
  const result = requeueSchema.safeParse({ ...values, DATABASE_URL: env["DATABASE_URL"] });
  if (!result.success) {
    throw new Error(
      `Usage: outbox:requeue --service <booking|payment|notification> --id <outbox id> --operator <name> --reason <text>\n${z.prettifyError(result.error)}`,
    );
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    service: result.data.service,
    outboxId: result.data.id,
    operator: result.data.operator,
    reason: result.data.reason,
  };
}
