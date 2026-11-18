export interface UpstashEndpoint {
  readonly url: string;
  readonly token: string;
}

/** Runs one command through the Upstash REST protocol and returns its `result`. */
export async function upstashCommand(
  endpoint: UpstashEndpoint,
  args: readonly (string | number)[],
): Promise<unknown> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null) {
    throw new Error(`Upstash ${String(args[0])} failed: HTTP ${response.status}`);
  }
  if ("error" in body) {
    throw new Error(`Upstash ${String(args[0])} failed: ${String(body.error)}`);
  }
  return "result" in body ? body.result : undefined;
}

/** Deletes every key under `prefix` through the REST endpoint (it may not front TEST_REDIS_URL). */
export async function deleteUpstashKeys(endpoint: UpstashEndpoint, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const reply = await upstashCommand(endpoint, [
      "SCAN",
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      200,
    ]);
    const [next, keys]: unknown[] = Array.isArray(reply) ? reply : [];
    if (next === undefined || !Array.isArray(keys)) {
      throw new Error("Upstash SCAN returned an unexpected reply");
    }
    cursor = String(next);
    const names = keys.map(String);
    if (names.length > 0) {
      await upstashCommand(endpoint, ["DEL", ...names]);
    }
  } while (cursor !== "0");
}
