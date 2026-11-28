import { parseArgs } from "node:util";
import type { PrismaClient } from "@ticketarena/db";
import {
  type ConsumerAdmin,
  type ConsumerRunnerOptions,
  type RecreateConsumerResult,
  recreateConsumer,
  type ServiceName,
} from "@ticketarena/messaging";
import { z } from "zod";

const recoverSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  NATS_URL: z.url({ protocol: /^(nats|tls)$/ }),
  NATS_TOKEN: z.string().min(1).optional(),
  consumer: z.string().trim().min(1),
});

export interface RecoverCommand {
  readonly databaseUrl: string;
  readonly natsUrl: string;
  readonly natsToken?: string;
  readonly consumer: string;
  readonly ignoreAckFloor: boolean;
}

/**
 * Validates `consumer:recover --consumer <durable name> [--ignore-ack-floor]` and its
 * `DATABASE_URL`, `NATS_URL` and optional `NATS_TOKEN`, naming every bad field at once.
 */
export function parseRecoverCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): RecoverCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      consumer: { type: "string" },
      "ignore-ack-floor": { type: "boolean", default: false },
    },
    strict: true,
  });
  const result = recoverSchema.safeParse({
    consumer: values.consumer,
    DATABASE_URL: env["DATABASE_URL"],
    NATS_URL: env["NATS_URL"],
    NATS_TOKEN: env["NATS_TOKEN"],
  });
  if (!result.success) {
    throw new Error(
      `Usage: consumer:recover --consumer <durable name> [--ignore-ack-floor]\n${z.prettifyError(result.error)}`,
    );
  }
  return {
    databaseUrl: result.data.DATABASE_URL,
    natsUrl: result.data.NATS_URL,
    ...(result.data.NATS_TOKEN === undefined ? {} : { natsToken: result.data.NATS_TOKEN }),
    consumer: result.data.consumer,
    ignoreAckFloor: values["ignore-ack-floor"],
  };
}

export interface RecoverServiceConsumerInput {
  readonly admin: ConsumerAdmin;
  readonly prisma: PrismaClient;
  /** The worker's consumers (`createServiceConsumers`): the name selects filter and service. */
  readonly consumers: readonly Pick<
    ConsumerRunnerOptions,
    "consumer" | "filterSubject" | "service"
  >[];
  readonly consumer: string;
  readonly ignoreAckFloor: boolean;
  readonly now: Date;
}

export interface RecoverReport extends RecreateConsumerResult {
  readonly service: ServiceName;
  readonly filterSubject: string;
}

/**
 * Recreates one of the worker's durable consumers (ADR 0011 consumer recovery) with exactly the
 * filter it subscribes with and against its own service's `processed_messages`, so the operator
 * names only the consumer and cannot pair it with the wrong checkpoint.
 */
export async function recoverServiceConsumer(
  input: RecoverServiceConsumerInput,
): Promise<RecoverReport> {
  const known = input.consumers.find((candidate) => candidate.consumer === input.consumer);
  if (known === undefined) {
    throw new Error(
      `unknown consumer "${input.consumer}"; the worker's consumers are: ${input.consumers.map((candidate) => candidate.consumer).join(", ")}`,
    );
  }
  const service = known.service ?? "booking";
  const result = await recreateConsumer({
    admin: input.admin,
    prisma: input.prisma,
    service,
    consumer: known.consumer,
    filterSubject: known.filterSubject,
    now: input.now,
    ignoreAckFloor: input.ignoreAckFloor,
  });
  return { ...result, service, filterSubject: known.filterSubject };
}
