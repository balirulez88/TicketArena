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

/** Declares a stream capturing exactly `subjects`, e.g. one misconfigured without a subject. */
export async function declareStream(
  url: string,
  name: string,
  subjects: readonly string[],
): Promise<void> {
  const connection = await connect({ servers: url });
  try {
    await (await jetstreamManager(connection)).streams.add({ name, subjects: [...subjects] });
  } finally {
    await connection.close();
  }
}

/** Deletes a durable consumer, so a new one of the same name replays the stream from the start. */
export async function deleteConsumer(url: string, stream: string, consumer: string): Promise<void> {
  const connection = await connect({ servers: url });
  try {
    await (await jetstreamManager(connection)).consumers.delete(stream, consumer);
  } finally {
    await connection.close();
  }
}
