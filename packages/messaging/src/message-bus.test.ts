import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setupTestNats } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";
import * as messaging from "./index.js";

const nats = setupTestNats();
const repoRoot = join(import.meta.dirname, "../../..");
const ADAPTER_PATH = "packages/messaging/src/jetstream-message-bus.ts";
// Fixture that boots a NATS container: test infrastructure, not production code.
const TEST_SUPPORT = ["packages/test-infra/src/nats.ts"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function listSources(root: string): string[] {
  return ["apps", "packages"].flatMap((top) => walk(join(root, top)));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

interface BusHandle {
  ensureTopology(): Promise<void>;
  close(): Promise<void>;
}
type ConnectBus = (options: { servers: string }) => Promise<BusHandle>;

function connectJetStreamMessageBus(): ConnectBus {
  const factory: unknown = Reflect.get(messaging, "connectJetStreamMessageBus");
  if (typeof factory !== "function") {
    throw new Error("@ticketarena/messaging must export connectJetStreamMessageBus (the adapter)");
  }
  return factory as ConnectBus;
}

describe("MessageBus port and JetStream adapter", () => {
  it("is exported by the package entry point and creates the topology idempotently", async () => {
    const bus = await connectJetStreamMessageBus()({ servers: nats.url });
    try {
      await bus.ensureTopology();
      await expect(bus.ensureTopology()).resolves.toBeUndefined();
    } finally {
      await bus.close();
    }
  });

  it("keeps @nats-io/* imports inside the adapter module across apps and packages", () => {
    const sources = listSources(repoRoot).map((file) => relative(repoRoot, file));
    expect(sources).toContain(ADAPTER_PATH);
    const offenders = sources.filter(
      (file) =>
        file !== ADAPTER_PATH &&
        !TEST_SUPPORT.includes(file) &&
        /@nats-io\//.test(readFileSync(join(repoRoot, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
