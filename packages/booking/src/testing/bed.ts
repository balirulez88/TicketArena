import { randomUUID } from "node:crypto";
import { seedCatalog } from "@ticketarena/db/seed";
import { beforeAll } from "vitest";
import { type BookingServiceDeps, createBookingService } from "../booking-service";
import { type TestClients, type TestDatabaseUrl, testClients, withClient } from "./clients";
import { freeSeats, NOW } from "./fixtures";

export interface BookingTestBed extends TestClients {
  /** A booking service on the test's client at `NOW`, with fresh ids; `deps` override any part. */
  service(deps?: Partial<BookingServiceDeps>): ReturnType<typeof createBookingService>;
  /** The same service with its clock fixed at `when`. */
  at(when: Date, deps?: Partial<BookingServiceDeps>): ReturnType<typeof createBookingService>;
  /** `count` free seats of the demo event (or of `eventId`), read with the test's client. */
  freeSeats(
    count: number,
    options?: { eventId?: string; order?: "asc" | "desc" },
  ): Promise<{ eventId: string; seatIds: string[] }>;
}

/**
 * The setup every booking test file shares: the catalog seeded once at `NOW` on a client of its
 * own, then a client per test (`testClients`). Call it at the top of the file, after
 * `setupTestDatabase()`.
 */
export function bookingTestBed(database: TestDatabaseUrl): BookingTestBed {
  beforeAll(() => withClient(database, (db) => seedCatalog(db, NOW)));
  const clients = testClients(database);
  const service = (deps: Partial<BookingServiceDeps> = {}) =>
    createBookingService({
      db: clients.db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      ...deps,
    });
  return {
    ...clients,
    service,
    at: (when, deps = {}) => service({ clock: { now: () => when }, ...deps }),
    freeSeats: (count, options) => freeSeats(clients.db(), count, options),
  };
}
