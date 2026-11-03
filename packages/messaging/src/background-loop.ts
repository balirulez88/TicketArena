export interface BackgroundLoop {
  start(): void;
  /** Lets the in-flight iteration finish, then resolves. */
  stop(): Promise<void>;
}

/**
 * Repeats `iteration` until stopped. The iteration owns its error handling and pacing: a throw
 * would end the loop silently, so callers catch outages and decide how long to back off.
 */
export function createBackgroundLoop(iteration: () => Promise<void>): BackgroundLoop {
  let running: Promise<void> | undefined;
  let stopping = false;

  return {
    start() {
      if (running !== undefined) {
        return;
      }
      stopping = false;
      running = (async () => {
        while (!stopping) {
          await iteration();
        }
      })();
    },
    async stop() {
      stopping = true;
      await running;
      running = undefined;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
