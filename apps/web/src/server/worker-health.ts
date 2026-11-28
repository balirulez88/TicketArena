import type { Logger } from "@ticketarena/contracts";
import { z } from "zod";
import { parseWorkerHealthEnv } from "./env";

const count = z.number().int().nonnegative();

/** The broker's message-health figures as the worker's `/health` reports them under `delivery`. */
export const deliveryFiguresSchema = z.object({
  consumers: z.record(
    z.string(),
    z.object({ lag: count, pendingAcks: count, redeliveries: count }).nullable(),
  ),
  dlq: z.object({ size: count, oldestAgeMs: count.nullable() }),
});

export type DeliveryFigures = z.infer<typeof deliveryFiguresSchema>;

/**
 * Only the part the dashboard reads; other fields are the worker's to add. A worker that does not
 * probe the broker, or could not this time, has no figures (`unavailable` or no `delivery`).
 */
const workerHealthSchema = z.object({
  status: z.literal("ok"),
  delivery: z.union([deliveryFiguresSchema, z.literal("unavailable")]).optional(),
});

export interface WorkerHealthReader {
  /** The figures, or `null` when the worker has none; rejects when the worker cannot be read. */
  read(): Promise<DeliveryFigures | null>;
}

/** Below the dashboard's 1 s poll, so a hung worker never piles up snapshot requests. */
const DEFAULT_TIMEOUT_MS = 800;

export function createWorkerHealthReader(config: {
  readonly url: string;
  readonly timeoutMs?: number;
}): WorkerHealthReader {
  return {
    async read() {
      let response: Response;
      try {
        response = await fetch(config.url, {
          signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown error";
        throw new Error(`worker health request did not complete (${reason})`);
      }
      if (!response.ok) {
        throw new Error(`worker health answered HTTP ${response.status}`);
      }
      const parsed = workerHealthSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new Error(`worker health is malformed: ${z.prettifyError(parsed.error)}`);
      }
      const { delivery } = parsed.data;
      return delivery === undefined || delivery === "unavailable" ? null : delivery;
    },
  };
}

/**
 * Reads `WORKER_HEALTH_URL` on first call and caches the outcome, success or failure, so a bad
 * configuration is logged once at the boundary and later calls rethrow without re-reading it.
 */
export function createLazyWorkerHealth(config: {
  readonly readEnv: () => Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
}): () => WorkerHealthReader {
  let outcome: { value: WorkerHealthReader } | { failure: Error } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        const env = parseWorkerHealthEnv(config.readEnv());
        outcome = { value: createWorkerHealthReader({ url: env.WORKER_HEALTH_URL }) };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        config.logger.warn({ err: failure.message }, "worker health is not configured");
        outcome = { failure };
      }
    }
    if ("failure" in outcome) {
      throw outcome.failure;
    }
    return outcome.value;
  };
}
