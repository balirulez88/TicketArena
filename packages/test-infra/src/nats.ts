import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";

/** Deletes every JetStream stream whose name starts with `prefix`. */
export async function deleteStreams(url: string, prefix: string): Promise<void> {
  const connection = await connect({ servers: url });
  try {
    const manager = await jetstreamManager(connection);
    const doomed: string[] = [];
    for await (const stream of manager.streams.list()) {
      if (stream.config.name.startsWith(prefix)) {
        doomed.push(stream.config.name);
      }
    }
    for (const name of doomed) {
      await manager.streams.delete(name);
    }
  } finally {
    await connection.close();
  }
}
