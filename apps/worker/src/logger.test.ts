import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWorkerLogger } from "./logger.js";

describe("worker logger", () => {
  it("writes JSON lines carrying the ids bound on a child", () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    });
    const correlationId = crypto.randomUUID();

    createWorkerLogger(sink).child({ correlationId, causationId: null }).info({}, "hi");

    expect(JSON.parse(chunks.join(""))).toMatchObject({ name: "worker", msg: "hi", correlationId });
  });
});
