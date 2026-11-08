import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@ticketarena/contracts";
import { afterEach, describe, expect, test } from "vitest";

const TOKEN = "super-secret-token";

interface Seen {
  method?: string | undefined;
  url?: string | undefined;
  authorization?: string | undefined;
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open === undefined) {
    return;
  }
  open.closeAllConnections();
  await new Promise((resolve) => open.close(resolve));
});

async function fake(
  respond: (res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { body: "" };
  server = createServer((req: IncomingMessage, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.authorization = req.headers.authorization;
    req.on("data", (chunk) => {
      seen.body += String(chunk);
    });
    req.on("end", () => respond(res));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const json = (status: number, body: unknown) => (res: import("node:http").ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("createUpstashMetricsClient", () => {
  test("hIncrBy POSTs the HINCRBY command with the bearer token and returns the result", async () => {
    const { createUpstashMetricsClient } = await import("./upstash-metrics");
    const { url, seen } = await fake(json(200, { result: 7 }));

    const result = await createUpstashMetricsClient({ url, token: TOKEN }).hIncrBy("k", "f", 1);

    expect(result).toBe(7);
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/");
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen.body)).toEqual(["HINCRBY", "k", "f", 1]);
  });

  test("a non-2xx response rejects naming HINCRBY and never the token", async () => {
    const { createUpstashMetricsClient } = await import("./upstash-metrics");
    const { url } = await fake(json(401, { error: "unauthorized" }));

    const failure = await createUpstashMetricsClient({ url, token: TOKEN })
      .hIncrBy("k", "f", 1)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/HINCRBY/);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });

  test("a 200 response with an error body rejects naming HINCRBY and never the token", async () => {
    const { createUpstashMetricsClient } = await import("./upstash-metrics");
    const { url } = await fake(json(200, { error: "WRONGTYPE" }));

    const failure = await createUpstashMetricsClient({ url, token: TOKEN })
      .hIncrBy("k", "f", 1)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/HINCRBY/);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });

  test("a server that never answers rejects naming HINCRBY once the timeout elapses", async () => {
    const { createUpstashMetricsClient } = await import("./upstash-metrics");
    const { url } = await fake(() => undefined);

    const failure = await createUpstashMetricsClient({ url, token: TOKEN, timeoutMs: 50 })
      .hIncrBy("k", "f", 1)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/HINCRBY/);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });
});

describe("createLazyMetrics", () => {
  const recordingLogger = () => {
    const errors: { fields: object; message?: string | undefined }[] = [];
    const logger: Logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (fields, message) => {
        errors.push({ fields, message });
      },
      child: () => logger,
    };
    return { logger, errors };
  };

  test("does not read the environment until first resolved", async () => {
    const { createLazyMetrics } = await import("./upstash-metrics");
    let reads = 0;
    const { logger } = recordingLogger();

    createLazyMetrics({
      readEnv: () => {
        reads += 1;
        return {};
      },
      logger,
    });

    expect(reads).toBe(0);
  });

  test("a bad configuration logs once, fails every time with the same message and parses once", async () => {
    const { createLazyMetrics } = await import("./upstash-metrics");
    let reads = 0;
    const { logger, errors } = recordingLogger();
    const metrics = createLazyMetrics({
      readEnv: () => {
        reads += 1;
        return { UPSTASH_REDIS_REST_TOKEN: "t" };
      },
      logger,
    });

    const messages = [1, 2].map(() => {
      try {
        metrics();
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.message : "not an error";
      }
    });

    expect(messages[0]).toMatch(/UPSTASH_REDIS_REST_URL/);
    expect(messages[1]).toBe(messages[0]);
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toMatch(/UPSTASH_REDIS_REST_URL/);
  });

  test("a valid configuration resolves one cached BookingMetrics", async () => {
    const { createLazyMetrics } = await import("./upstash-metrics");
    let reads = 0;
    const { logger, errors } = recordingLogger();
    const metrics = createLazyMetrics({
      readEnv: () => {
        reads += 1;
        return {
          UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
          UPSTASH_REDIS_REST_TOKEN: "t",
        };
      },
      logger,
    });

    expect(metrics()).toBe(metrics());
    expect(reads).toBe(1);
    expect(errors).toHaveLength(0);
  });
});
