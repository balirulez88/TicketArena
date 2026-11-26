import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** `ok` answers like Upstash; `error` answers HTTP 500; `silent` never answers at all. */
export type FakeUpstashMode = "ok" | "error" | "silent";

export interface FakeUpstash {
  readonly url: string;
  /** Every command received, in arrival order, as its JSON body, e.g. `["HINCRBY", k, f, 1]`. */
  readonly commands: readonly (readonly unknown[])[];
  close(): Promise<void>;
}

/**
 * Test-only: a local stand-in for the Upstash REST endpoint, the system boundary of the metrics
 * client. In `ok` mode `HINCRBY` answers the field's running total, as Redis would.
 */
export async function startFakeUpstash(mode: FakeUpstashMode = "ok"): Promise<FakeUpstash> {
  const commands: unknown[][] = [];
  const totals = new Map<string, number>();
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      const command = Array.isArray(parsed) ? parsed : [parsed];
      commands.push(command);
      if (mode === "silent") {
        return;
      }
      if (mode === "error") {
        answer(res, 500, { error: "ERR fake upstash failure" });
        return;
      }
      const [name, key, field, increment] = command;
      if (name !== "HINCRBY" || typeof increment !== "number") {
        answer(res, 400, { error: `ERR fake upstash does not support ${String(name)}` });
        return;
      }
      const total = (totals.get(`${String(key)} ${String(field)}`) ?? 0) + increment;
      totals.set(`${String(key)} ${String(field)}`, total);
      answer(res, 200, { result: total });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    commands,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A local URL nothing listens on, so a request to it is refused at once. */
export async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
