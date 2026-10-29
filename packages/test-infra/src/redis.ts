import { createClient } from "redis";

/** Deletes every key under `prefix`; the cleanup half of a per-file Redis namespace. */
export async function deleteRedisKeys(url: string, prefix: string): Promise<void> {
  const client = createClient({ url });
  await client.connect();
  try {
    for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
      if (keys.length > 0) {
        await client.del(keys);
      }
    }
  } finally {
    client.destroy();
  }
}
