# Technical Debt Register

[← System map](index.md)

The canonical record of review findings that were **deferred instead of fixed**. It lives in the
repository, so it reaches every later ticket, agent and reviewer through `main`, like code and
ADRs do. Review reports in `.ralph/logs/` expire after 30 days; this register does not.

## Rules

- **What goes in.** Every `MEDIUM` and `LOW` finding still unresolved when a slice is approved.
  `CRITICAL` and `HIGH` findings block the merge ([merge policy](workflow/index.md#independent-review))
  and never become debt. A deferred finding whose real impact outgrows its severity is
  **escalated**: it keeps its original severity, says why in `Escalation`, and must be `PLANNED`,
  `IN_PROGRESS` or `RESOLVED`, never left `OPEN` or `ACCEPTED_RISK`.
- **Statuses.** `OPEN` (deferred, no plan yet), `PLANNED` (a `Target` ticket or milestone will fix
  it), `IN_PROGRESS`, `RESOLVED`, `ACCEPTED_RISK` (a deliberate decision to live with it). Every
  status except `RESOLVED` needs a `Justification`.
- **Resolving.** Only a change that fixes the problem resolves an entry: `Resolution` says what
  changed and `Verification` names the test that proves it (`` `path::test name` ``, the file
  must exist). Reviewers check the claim; Ralph adds a `resolution verified` history line when the
  slice merges. No deadline is ever invented: `Target` names a ticket or stays `none`.
- **Append-only.** Entries are never deleted; ids are never reused. A resolved problem that is
  reported again is reopened.
- **Format.** Between the markers below the file is owned by `scripts/ralph-debt.mjs`: edit field
  values in place, then run `pnpm run format:debt`. `pnpm run check:debt` (part of
  `pnpm run check` and of Ralph's gate) rejects an invalid or unformatted register.

How Ralph maintains it: [workflow](workflow/index.md#technical-debt-register).

<!-- ralph-debt:begin -->

## Summary

Generated from the entries below by `node scripts/ralph-debt.mjs format`.

| Status        | CRITICAL | HIGH | MEDIUM | LOW | Total |
| ------------- | -------- | ---- | ------ | --- | ----- |
| OPEN          | 0        | 0    | 3      | 35  | 38    |
| PLANNED       | 0        | 0    | 9      | 2   | 11    |
| IN_PROGRESS   | 0        | 1    | 0      | 0   | 1     |
| RESOLVED      | 0        | 0    | 5      | 2   | 7     |
| ACCEPTED_RISK | 0        | 0    | 0      | 0   | 0     |

## Entries

### TD-001: packages/db reads process.env directly

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/src/seed-main.ts:6`
- **Problem:** seed-main.ts reads process.env["DATABASE_URL"] inside the db package. The comment justifies it as a CLI boundary, but the documented rule has no exception for package scripts, and the code-review hard rules say a breach is at least HIGH.
- **Impact:** This sets a precedent that weakens the dependency-injection rule. There is no concrete runtime failure, which is why I rate it MEDIUM and not HIGH.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment).
- **Remediation:** Take the URL as a CLI argument, or put the entry point in an app or scripts workspace that validates env. Alternatively, record the CLI-entry exception in CLAUDE.md or an ADR so the rule and the code agree.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/seed-main.ts#packages-db-reads-process-env-directly`
- **History:**
  - 2026-10-30: recorded: MEDIUM architecture at `packages/db/src/seed-main.ts:6`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38 (user decision, 2026-11-03)

### TD-002: Venue seeding is check-then-create on a non-unique column

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/src/seed.ts:53`
- **Problem:** Venues are found with findFirst by name and created if absent, but venues.name has no unique constraint. Sections, rows and events use upserts on unique keys, so venue is the only entity whose idempotency depends on a non-atomic check.
- **Impact:** Two concurrent `db:seed` runs (for example parallel deploy jobs) can both miss and both create 'Arena Central'. Duplicate venues then survive. Later findFirstOrThrow calls on the venue name pick an arbitrary one, so events and sections can attach to different copies, and the docs claim idempotency.
- **Justification:** Only concurrent seed runs trigger it, and no deployment runs the seed yet; fixed before ticket 38 (deployment) can run seeds from deploy hooks.
- **Remediation:** Add @@unique on Venue.name (with a migration) and use upsert with update: {} like the other entities.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** Venues are inserted with `createMany(skipDuplicates)` (ON CONFLICT DO NOTHING) on the new unique `venues.name` (migration `20261030030000`); sections, rows and events use the same atomic insert because Prisma `upsert` still raced.
- **Verification:** `packages/db/src/seed.test.ts::seedCatalog concurrent runs leave exactly one row per venue`
- **Fingerprints:** `packages/db/src/seed.ts#venue-seeding-is-check-then-create-on-a-non-unique-column`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/db/src/seed.ts:53`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-003: Every request now requires DATABASE_URL, even procedures that do not use the db

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/trpc.ts:36`
- **Problem:** createTRPCContext calls database(), which parses DATABASE_URL, for every request. health.check and session.whoami never touch the db.
- **Impact:** A missing or invalid DATABASE_URL turns the health check and whoami into 500s. A liveness probe then cannot tell a running process from an unreachable database. The env error also appears on unrelated routes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment).
- **Remediation:** Make ctx.db a lazy accessor (for example a getter or `db: () => PrismaClient`) that is evaluated only by procedures that need it, or add a separate readiness check so that health.check stays independent of the database.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/trpc.ts#every-request-now-requires-database-url-even-procedures-that`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `apps/web/src/server/trpc.ts:36`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38 (user decision, 2026-11-03)

### TD-004: Module-level mutable singleton hides the client lifecycle

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/trpc.ts:24`
- **Problem:** sharedDb is mutable module state created inside trpc.ts. It has no way to be replaced or disconnected, and the driver is hard-coded to "neon".
- **Impact:** Nothing can swap the client or close it in tests. Hot-reload behaviour in dev is untested. This is minor and the comment explains why.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Acceptable for this ticket. If more infrastructure joins the context, move construction into a small composition-root module that createTRPCContext receives.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/trpc.ts#module-level-mutable-singleton-hides-the-client-lifecycle`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/trpc.ts:24`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-005: unusedDb helper duplicated across test files, built from a fake URL

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/health.test.ts:6`
- **Problem:** The same unusedDb factory, with the same fake connection string and comment, is copied into health.test.ts and session.test.ts. The tests also rely on the client never connecting, which is an unstated assumption of the driver.
- **Impact:** A change to the client factory or to its lazy-connect behaviour must be fixed in several places. A driver that connects eagerly would make these unrelated tests fail.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Share a single helper, for example in a test-support module, or let these tests use the real test database like catalog.test.ts does.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/health.test.ts#unuseddb-helper-duplicated-across-test-files-built-from-a-fa`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/routers/health.test.ts:6`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-006: Seat-map tests depend on execution order and shared mutated state

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/catalog.test.ts:99`
- **Problem:** The first seats.map test asserts that map.seats[0] has status AVAILABLE. A later test marks an arbitrary findFirst seat as SOLD in the same shared database. Nothing pins the seat updated to a position other than the first. seed.test.ts has the same pattern: an earlier test asserts all statuses are AVAILABLE, and a later one writes SOLD.
- **Impact:** Reordering tests, or a Prisma default ordering change, makes them fail or pass for the wrong reason. The suite is currently green only because of declaration order.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Make each test create its own fixture state, or reset it in beforeEach (reseed or delete). Choose the SOLD seat explicitly, for example the last one in the map order.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/catalog.test.ts#seat-map-tests-depend-on-execution-order-and-shared-mutated-`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `apps/web/src/server/routers/catalog.test.ts:99`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-007: tsx is added with a caret range

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/package.json:27`
- **Problem:** The new devDependency is "tsx": "^4.23.15", while every other dependency in the manifest is pinned exactly.
- **Impact:** The version drifts between installs without a lockfile update. The impact is small because the lockfile pins it.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Pin it as "tsx": "4.23.15".
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/package.json#tsx-is-added-with-a-caret-range`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/db/package.json:27`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-008: Alias exports and unconstrained money and currency fields

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/catalog-schemas.ts:5`
- **Problem:** eventInput and seatMapInput are aliases of the same schema. currency is `z.string().length(3)` and Section.currency is a free-form String in the DB, although the ticket fixes the currency at EUR. The migration has no CHECK on priceMinor >= 0.
- **Impact:** The API contract and DB do not enforce the 'EUR, integer minor units, non-negative' rule that the ticket describes. A bad seed or manual write would pass through.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Use `z.literal("EUR")` or an enum for currency, and a DB CHECK for priceMinor >= 0. A single shared input schema would do instead of the aliases.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/catalog-schemas.ts#alias-exports-and-unconstrained-money-and-currency-fields`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/routers/catalog-schemas.ts:5`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-009: multiSchema configuration is not asserted by any test

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.spec.json`
- **Components:** `packages/db/prisma/schema.prisma:10`
- **Problem:** The datasource sets schemas = ["public"] and every model and enum has @@schema("public"), but no test checks this. The catalog tests would pass if multiSchema were removed.
- **Impact:** A later edit could drop the multiSchema setup without any test failing; the risk is low.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Add a cheap check, e.g. a test that reads schema.prisma for the schemas setting, or asserts that the tables and the SeatStatus type live in the public schema via information_schema.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#multischema-configuration-is-not-asserted-by-any-test`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/db/prisma/schema.prisma:10`, spec axis (ticket 03 review-2 spec, run 20261030-132411)

### TD-010: seedCatalog is exported from the runtime barrel of @ticketarena/db

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-1.standards.json` (round 1; not repeated in the approved round 2, still present)
- **Components:** `packages/db/src/index.ts:19`
- **Problem:** seedCatalog is re-exported from the db barrel that the web app imports at runtime, so demo-catalog data and seeding logic sit in the production server module graph although only tests and the CLI need them.
- **Impact:** A wider public surface than the API needs, and a request path could call the seeder by accident.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed.
- **Remediation:** Expose the seeder through a separate entry point (e.g. a `./seed` export) used only by tests and the CLI.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)

### TD-011: The db:seed entry point is not exercised by any test

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-1.spec.json` (round 1; still present)
- **Components:** `packages/db/src/seed-main.ts:6`
- **Problem:** Tests call seedCatalog directly; the script `pnpm db:seed` runs (env guard, driver choice, disconnect) is never executed by the suite.
- **Impact:** A broken entry point passes the gate and fails only when someone seeds a database.
- **Justification:** LOW and dev-only today. Best fixed together with TD-001, which moves the entry point to a boundary that validates config.
- **Remediation:** When TD-001 moves the CLI to an app boundary, test it end to end against the test database.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)

### TD-012: No index on seats.holdId, which is now a foreign key and a lookup key

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/db/prisma/migrations/20261030010000_holds/migration.sql:22`
- **Problem:** The migration adds the FK seats.holdId -> holds.id with ON DELETE SET NULL and no index on holdId. getHold includes seats by holdId, and any later hold delete, release or expiry will filter or cascade on it.
- **Impact:** On a large seats table, every getHold does a sequential scan of seats. Hold-lifecycle updates do the same, and they run while seat row locks are held. That adds latency and lock time on the hot path during a sale spike.
- **Justification:** Seat tables are small until load tests; fixed before ticket 39 (load tests) exercises getHold and expiry at scale.
- **Remediation:** Add @@index([holdId]) to Seat in schema.prisma and CREATE INDEX "seats_holdId_idx" ON "seats"("holdId") in the migration.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** `@@index([holdId])` on Seat and `seats_holdId_idx` in migration `20261030030000`.
- **Verification:** `packages/db/src/seed.test.ts::seedCatalog has an index on seats.holdId`
- **Fingerprints:** `packages/db/prisma/migrations/20261030010000_holds/migration.sql#no-index-on-seats-holdid-which-is-now-a-foreign-key-and-a-lo`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/db/prisma/migrations/20261030010000_holds/migration.sql:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-013: Lazy hold expiry is not implemented; expired holds block seats until a sweeper exists

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** Booking-correctness risk. Business impact is HIGH for any real on-sale: every abandoned hold makes its seats unsellable for good. No release that depends on expired seats becoming available again may ship before ticket 14 merges and its tests (AT-07: an expired hold's seat can be held by another buyer before the sweeper runs) pass; ticket 38 (deployment) is blocked by ticket 14.
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`; `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.spec.json`
- **Components:** `packages/booking/src/booking-service.ts:73`, `packages/db/prisma/schema.prisma:143`
- **Problem:** Only seats with status === "AVAILABLE" are accepted. The Hold model comment says a HELD seat with an expired hold is treated as free at decision time, and ADR 0005 says the same, but nothing here implements it. Nothing else in this slice resets expired holds.
- **Impact:** Abandoned holds keep their seats unsellable forever until a later slice adds expiry. The comment misleads readers. The decidedAt-after-lock design is also only half used, because it is never compared with an existing hold's expiry.
- **Justification:** Ticket 14 implements lazy expiry and the sweeper as specified in ADR 0005; nothing is deployed, so no real seat is blocked yet.
- **Remediation:** Either implement the ADR rule (join holds and treat HELD with holdExpiresAt <= decidedAt as free, then re-claim), or remove the lazy-expiry claim from the schema comment and record it as deferred to the expiry ticket.
- **Target:** ticket 14 (`issues/14-hold-expiry.md`), AC1 and AC7
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#availability-check-ignores-lazy-expiry-so-the-schema-comment`; `packages/db/prisma/schema.prisma#schema-comment-promises-lazy-expiry-that-is-not-implemented`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `packages/booking/src/booking-service.ts:73`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-10-30: recorded: LOW scope_creep at `packages/db/prisma/schema.prisma:143`, spec axis (ticket 04 review-1 spec, run 20261030-134316)
  - 2026-10-30: merged duplicate (spec axis, LOW: the Hold schema comment promises lazy expiry) during backfill
  - 2026-10-30: escalation flagged (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: planned for ticket 14 (`issues/14-hold-expiry.md`), AC1 and AC7 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-03: ticket 38 now lists ticket 14 as a blocker, so deployment cannot start before lazy expiry is verified (user decision, 2026-11-03)

### TD-014: Duplicate seat ids are not rejected at the service level

- **Status:** RESOLVED
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:74`
- **Problem:** seatIds containing the same id twice locks one row. The free set contains it, so the check passes. The envelope and HoldView then repeat the id, and the router's length(1) currently hides this. The service also has no min-length check, and an empty array would create a hold with no seats and fail at envelope.parse (min(1)) only after the hold row has been written, which rolls back.
- **Impact:** This is latent. It becomes reachable when the 6-seat limit lands and the router guard is relaxed.
- **Justification:** Unreachable today: the router accepts exactly one seat id. Must be closed before ticket 11 relaxes the router to 1-6 seats.
- **Remediation:** Dedupe or reject duplicate and empty seatIds at the start of holdSeats, and add a test.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** `holdSeats` throws `InvalidSeatSelectionError` for an empty or duplicated `seatIds` before the transaction; the router maps it to `BAD_REQUEST`.
- **Verification:** `packages/booking/src/booking-service.test.ts::holdSeats seat selection rejects a duplicated seatIds list before writing anything`
- **Fingerprints:** `packages/booking/src/booking-service.ts#duplicate-seat-ids-are-not-rejected-at-the-service-level`
- **History:**
  - 2026-10-30: recorded: LOW defect at `packages/booking/src/booking-service.ts:74`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-015: Envelope type hand-duplicates the schema shape

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/contracts/src/envelope.ts:22`
- **Problem:** Envelope<Payload> restates every field of envelopeSchema by hand instead of deriving it from the schema, so the two can drift.
- **Impact:** A field added to the schema without updating the type goes unnoticed by consumers.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Derive it with z.infer<ReturnType<typeof envelopeSchema<Payload>>>, or drop the type until a consumer needs it.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/contracts/src/envelope.ts#envelope-type-hand-duplicates-the-schema-shape`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/contracts/src/envelope.ts:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)

### TD-016: Clock-after-lock test depends on sleeps

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.test.ts:130`
- **Problem:** The test sleeps 100 ms and then 300 ms to order a blocker transaction against the service call. If holdSeats starts before the blocker locks, or the blocker commits before the clock is read, the result depends on timing. lockHeld is also cleared just before the transaction commits, not after.
- **Impact:** The test can flake on a slow CI machine. It can also pass in the window between the flag flip and the commit, even if the clock were read before the lock was acquired.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Synchronise on events instead of timers, for example poll pg_locks or pg_stat_activity until the service is waiting. Record the clock read order against a flag that is set only after the blocker has committed.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.test.ts#clock-after-lock-test-depends-on-sleeps`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/booking-service.test.ts:130`, standards axis (ticket 04 review-1 standards, run 20261030-134316)

### TD-017: HoldStatus and the status enum are duplicated across layers

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:22`
- **Problem:** The HoldStatus union is redeclared in the service, and the router's holdOutput repeats the status enum literals, although @ticketarena/db already exports HoldStatus.
- **Impact:** A status added to the Prisma enum must be edited in three places.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Reuse the HoldStatus type exported by @ticketarena/db in the service and derive the router enum from one shared constant.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#holdstatus-and-the-status-enum-are-duplicated-across-layers`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)

### TD-018: Atomicity not tested on a failure after the writes begin

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.spec.json`
- **Components:** `packages/booking/src/booking-service.test.ts:91`
- **Problem:** The only rollback-style test fails at the availability check, before any write. No test shows that a failure after the hold or seat update (for example an outbox write failure) leaves nothing behind.
- **Impact:** A refactor that moved the outbox write outside the transaction would still pass the suite, losing the "event exists iff the hold committed" guarantee.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Add a test that makes the outbox insert fail (for example a duplicate envelope id from a fixed newId) and asserts that no hold exists and the seat is still AVAILABLE.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.test.ts#atomicity-not-tested-on-a-failure-after-the-writes-begin`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/booking-service.test.ts:91`, spec axis (ticket 04 review-1 spec, run 20261030-134316)

### TD-019: Order lines priced from a different seat set than the one validated

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Escalation:** Money correctness: the amount charged (order.placed amountMinor, consumed by ticket 08) can differ from the validated, locked seat set, and an unlocked seat row can be mutated.
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:386`
- **Problem:** The validated and locked seat set is `expectedSeatIds` from the seat.held event. The price query and the `seat.updateMany` select seats with `WHERE holdId = ...` instead. If a seat carries this holdId but is not in the event's seat set, it is not locked or validated, yet it is priced into the order and set to IN_CHECKOUT.
- **Impact:** The total and the lines can diverge from what was validated, and a seat that was never locked can be mutated. This needs corrupted data, so the chance is low, but the code gives no guarantee against it.
- **Justification:** Needs a seat whose holdId disagrees with the hold's seat.held set, which no current code path produces; fixed before ticket 08 charges the order total.
- **Remediation:** Price by `id = ANY(expectedSeatIds)`, and update seats by the same id list with a `status = HELD` guard, so lines, total and mutation all use the one locked set.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** `placeOrder` prices by `id = ANY(expectedSeatIds)` and moves seats to `IN_CHECKOUT` by the same id list with a `status = HELD` guard.
- **Verification:** `packages/booking/src/place-order.test.ts::placeOrder acceptance: lock order and consistency neither prices nor mutates a seat that carries the hold's id but is outside its seat.held set`
- **Fingerprints:** `packages/booking/src/booking-service.ts#order-lines-priced-from-a-different-seat-set-than-the-one-va`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/booking/src/booking-service.ts:386`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: escalation flagged (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-020: placeOrder has no lock timeout, retry or BOOKING_BUSY mapping

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:351`
- **Problem:** The transaction runs with Prisma's default interactive-transaction timeout. It sets no lock_timeout or statement_timeout, and it does not retry deadlocks or serialization failures. The router passes unknown errors through unchanged.
- **Impact:** When the seats are contended, a buyer gets an opaque INTERNAL_SERVER_ERROR after the transaction times out. A deadlock or timeout is never retried. This extends a gap that already exists in holdSeats.
- **Justification:** Ticket 12 implements ADR 0005's timeouts, retry and BOOKING_BUSY for every booking transaction; contention only occurs under load, which ticket 10 introduces first.
- **Remediation:** Apply the ADR 0005 timeouts and bounded retry to the booking transactions. If that is deferred to another ticket, record it as a known limitation in docs/database/index.md.
- **Target:** ticket 12 (`issues/12-lock-timeout-and-deadlock-retry.md`)
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#placeorder-has-no-lock-timeout-retry-or-booking-busy-mapping`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `packages/booking/src/booking-service.ts:351`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 12 (`issues/12-lock-timeout-and-deadlock-retry.md`) (correctness review of tickets 03-05, 2026-10-30)

### TD-021: PG_UNIQUE_VIOLATION holds a Prisma error code

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:124`
- **Problem:** `P2002` is Prisma's unique-constraint error code. The Postgres SQLSTATE for a unique violation is 23505, so the name points at the wrong layer.
- **Impact:** A reader may assume raw Postgres errors are handled here. A driver-adapter change could break the check without anyone noticing.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review.
- **Remediation:** Rename it to `PRISMA_UNIQUE_CONSTRAINT`. Alternatively also recognise `meta`/SQLSTATE 23505 for the driver-adapter case.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#pg-unique-violation-holds-a-prisma-error-code`; `packages/messaging/src/consumer-runner.ts#pg-unique-violation-holds-prisma-s-p2002-again`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:124`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-11-03: seen again: LOW maintainability at `packages/messaging/src/consumer-runner.ts:5`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-022: Racing-duplicate test checks only the returned order ids

- **Status:** PLANNED
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/place-order.test.ts:123`
- **Problem:** The 5-way race asserts that the returned ids are equal. It does not assert that exactly one order row, one order.placed outbox row and one set of lines exist.
- **Impact:** The test still passes if a losing request wrote a duplicate outbox event or lines and returned the winner's order.
- **Justification:** Ticket 16 hardens checkout idempotency; its AT-12 asserts one order for concurrent duplicates.
- **Remediation:** Count `order` rows and `outboxEvent` rows for the hold and the order id, and expect 1 of each.
- **Target:** ticket 16 (`issues/16-checkout-idempotency-hardening.md`), AT-12
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/place-order.test.ts#racing-duplicate-test-checks-only-the-returned-order-ids`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/place-order.test.ts:123`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 16 (`issues/16-checkout-idempotency-hardening.md`), AT-12 (correctness review of tickets 03-05, 2026-10-30)

### TD-023: Hard-coded EUR fallback and repeated inline line shape

- **Status:** RESOLVED
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:390`
- **Problem:** `priced[0]?.currency ?? "EUR"` invents a currency that no input supports. The `{ seatId; priceMinor; currency }` line shape is repeated inline in OrderView and in the toOrderView parameter.
- **Impact:** If the unreachable branch is ever reached, it silently writes a made-up currency. The repeated shape invites drift.
- **Justification:** Unreachable while every section is EUR; fixed with TD-019 because the same code computes the total.
- **Remediation:** Throw on an empty priced set rather than defaulting. Define one `OrderLineView` type and use it in both places.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** The currency comes from the priced seats; an empty or mixed set throws `MixedCurrencyError` (router `CONFLICT`). One `OrderLineView` type replaces the inline shapes.
- **Verification:** `packages/booking/src/place-order.test.ts::placeOrder acceptance: lock order and consistency fails with a domain error when the held seats are priced in different currencies`
- **Fingerprints:** `packages/booking/src/booking-service.ts#hard-coded-eur-fallback-and-repeated-inline-line-shape`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:390`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-024: SEAT_UNAVAILABLE names no seat when the hold has no seats

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present)
- **Components:** `packages/booking/src/booking-service.ts:161`
- **Problem:** When the seat set is empty and no seat is lost, `new SeatUnavailableError([])` is thrown; its message names no seat, hiding the real cause (a hold without seats).
- **Impact:** A misleading CONFLICT for a corrupted hold that is hard to diagnose.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed.
- **Remediation:** Throw a distinct error (or message) for a hold with no seats.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)

### TD-025: placeOrder is one long method

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present)
- **Components:** `packages/booking/src/booking-service.ts:342`
- **Problem:** Replay fast path, lock sequence, validation, pricing, order creation, state transitions, outbox write and unique-violation recovery are all inline in one closure method.
- **Impact:** Hard to read and review; the order-sensitive lock section is buried among the other steps, which raises the risk of the lock-order regressions ADR 0005 forbids.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed.
- **Remediation:** Extract the locked section and the order construction into named functions while tickets 11, 12 and 14 change this method.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)

### TD-026: placeOrder skips the buyer advisory lock of ADR 0005's lock order

- **Status:** PLANNED
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present: no advisory lock in packages/booking)
- **Components:** `packages/booking/src/booking-service.ts:342`
- **Problem:** ADR 0005 orders locks as buyer advisory lock, hold, order, seats; holdSeats and placeOrder start at the seat or hold row. Harmless while no limit is enforced, but undocumented.
- **Impact:** When ticket 11 adds the buyer lock, any path that takes it after a row lock can deadlock against one that takes it first.
- **Justification:** The advisory lock serializes the per-event buyer limit, which arrives with ticket 11; its AC2 makes placeOrder take the same lock first.
- **Remediation:** Take pg_advisory_xact_lock(hash(eventId:buyerKey)) first in holdSeats and placeOrder, as ticket 11 AC2 specifies, with a test that races the two paths.
- **Target:** ticket 11 (`issues/11-multi-seat-holds-and-buyer-limit.md`), AC2
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)

### TD-027: placeOrder fails with an unhandled error once the hold's seat.held outbox row is gone

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** correctness review of tickets 03-05, 2026-10-30 (ticket 05 code)
- **Evidence:** `packages/booking/src/booking-service.ts:368` reads the seat set from the `seat.held` outbox row; `docs/specs/ticketarena-mvp.md:334` deletes outbox rows after 14 days
- **Components:** `packages/booking/src/booking-service.ts:368`, `packages/booking/src/booking-service.ts:371`
- **Problem:** The seat set of a hold is parsed from its `seat.held` outbox event before the hold's status and expiry are checked. A missing row makes `heldEnvelope.parse(undefined)` throw a ZodError, which the router passes through as INTERNAL_SERVER_ERROR.
- **Impact:** After outbox retention (14 days) a placeOrder on an old hold returns a 500 instead of HOLD_NOT_ACTIVE / HOLD_EXPIRED, and business logic depends on an integration log that ticket 06 starts to manage.
- **Justification:** No outbox row is deleted yet (no relay or retention job exists before ticket 06); fixed before the retention job can exist.
- **Remediation:** Refuse a non-HELD hold before reading the event, and map a missing seat.held event to a domain error instead of a 500, with a test.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Resolution:** `placeOrder` refuses a non-HELD hold before reading the event and maps a missing `seat.held` event to `HoldSeatSetMissingError` (router `CONFLICT`).
- **Verification:** `packages/booking/src/place-order.test.ts::placeOrder acceptance: lock order and consistency a HELD hold whose seat.held event is gone is a domain error`
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-028: Unique index on venues.name fails if duplicate venues already exist

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 41 (`41-booking-and-catalog-correctness-fixes`)
- **Evidence:** `.ralph/logs/20261030-175150/41-booking-and-catalog-correctness-fixes.review-1.standards.json`
- **Components:** `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql:2`
- **Problem:** The migration creates a UNIQUE INDEX on venues(name) without removing duplicates first. The old seed was a check-then-create on a non-unique column (TD-002), and that race is the reason for this fix. A database where concurrent seed runs already inserted duplicate venues cannot take the migration.
- **Impact:** prisma migrate deploy fails on such a database and blocks the deploy. The Ticket 38 deploy hooks that run seeds could hit this. Once the index exists the problem cannot recur.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** The migration must succeed on a database that already holds duplicate venue names, even though none is known to exist: before CREATE UNIQUE INDEX, keep one venue per name (a documented, deterministic survivor rule) and repoint its duplicates' sections and events to it. Failing early with a message alone is not enough. Prove it with an integration test that migrates a database seeded with duplicates.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), AC3 and AC4; must merge before ticket 38 (deployment), which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql#unique-index-on-venues-name-fails-if-duplicate-venues-alread`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql:2`, standards axis (ticket 41 review-1 standards, run 20261030-175150)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38; remediation narrowed to merging duplicates (user decision, 2026-11-03)

### TD-029: MixedCurrencyError doubles as the empty-set error

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 41 (`41-booking-and-catalog-correctness-fixes`)
- **Evidence:** `.ralph/logs/20261030-175150/41-booking-and-catalog-correctness-fixes.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:215`
- **Problem:** priceSeats throws MixedCurrencyError when the priced set is empty. The message is then 'seats are priced in ' with nothing after it, and the error name does not describe the problem. This also leaves the empty case with no test.
- **Impact:** If the unreachable branch is ever reached (for example a seat row vanishing between the lock and the pricing), the client gets a misleading MIXED_CURRENCY CONFLICT and the logs point at the wrong cause.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Throw a distinct error (or SeatUnavailableError) for an empty priced set, and keep MixedCurrencyError only for length > 1. Also consider asserting priced.length === seatIds.length.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#mixedcurrencyerror-doubles-as-the-empty-set-error`; `packages/booking/src/booking-service.ts#empty-priced-set-reported-as-mixedcurrencyerror-with-an-empt`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:215`, standards axis (ticket 41 review-1 standards, run 20261030-175150)
  - 2026-10-30: seen again: LOW maintainability at `packages/booking/src/booking-service.ts:215`, spec axis (ticket 41 review-1 spec, run 20261030-175150)

### TD-030: processedAt column type in the migration does not match the Prisma schema

- **Status:** OPEN
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/db/prisma/schema.prisma:221`
- **Problem:** The migration creates "processedAt" as TIMESTAMPTZ(3), but the model declares `DateTime @default(now())` with no `@db.Timestamptz(3)`. Prisma maps that to TIMESTAMP(3), so the schema and migration disagree.
- **Impact:** `prisma migrate diff` or `migrate dev` reports drift and generates a corrective migration that changes the column type. The schema is not the source of truth for the DB. Where Prisma writes the value (`@default(now())` is client-side for some paths), the timezone semantics are ambiguous.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Add `@db.Timestamptz(3)` to `processedAt` so the schema matches the migration.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#processedat-column-type-in-the-migration-does-not-match-the-`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/db/prisma/schema.prisma:221`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-031: Relay loop swallows every tick error without any signal

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:103`
- **Problem:** `catch {}` in the background loop drops database and broker outage errors with no log or counter. `lastError` is recorded only for publish failures inside a claimed row, not when claim, update or commit fails.
- **Impact:** If the database or NATS is down, or the claim query is broken, the worker keeps looping every 250 ms while `/health` reports ok. Pending events pile up and nobody can see why.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 45; nothing is deployed, so no outage has gone unseen yet.
- **Remediation:** Inject a logger or onError callback and report each failed tick (rate-limited). Consider a health signal for consecutive failures.
- **Target:** ticket 45 (`issues/45-worker-loop-error-reporting.md`); must merge before ticket 24, which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#relay-loop-swallows-every-tick-error-without-any-signal`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/messaging/src/outbox-relay.ts:103`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-04: planned for ticket 45 (`issues/45-worker-loop-error-reporting.md`), before ticket 24 (remediation planning, 2026-11-04)

### TD-032: Handler errors are nak'd with no trace, and the poll loop swallows all errors

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:74`
- **Problem:** When the handler or transaction throws, the runner calls `nak` and discards the error. The loop's `catch {}` at line 95 also drops fetch errors. MaxDeliver is -1, so a deterministic handler failure is redelivered forever, every 2 minutes after the 4th attempt, with the cause never recorded.
- **Impact:** A poison message loops indefinitely and is invisible. The docs admit the DLQ gate is not built, but there is not even a log of the failure.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 45 (and ticket 25 for the DLQ part). Handler failures are logged with the error and delivery count since ticket 07, but no test proves it yet and the poll loop still swallows fetch errors, so the entry stays open until ticket 45 verifies it.
- **Remediation:** Pass the error and delivery count to an injected error reporter before nak. Track the open DLQ gate as technical debt if it is deferred.
- **Target:** ticket 45 (`issues/45-worker-loop-error-reporting.md`) for the swallowed poll errors and the failure logging; the endless redelivery of a poison message is ticket 25's DLQ gate. Ticket 45 must merge before ticket 24, which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#handler-errors-are-nak-d-with-no-trace-and-the-poll-loop-swa`; `packages/booking/src/payment-saga.ts#unhandled-saga-cases-throw-into-an-invisible-unbounded-redel`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/messaging/src/consumer-runner.ts:74`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-03: seen again: MEDIUM regression_risk at `packages/booking/src/payment-saga.ts:88`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-04: planned for ticket 45 (`issues/45-worker-loop-error-reporting.md`), before ticket 24; poison-message loop left to ticket 25; handler-failure logging observed in code since ticket 07 but not yet verified by a test (remediation planning, 2026-11-04)

### TD-033: Retention is documented but no job exists

- **Status:** OPEN
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/db/prisma/schema.prisma:215`
- **Problem:** The model comment says rows are "Kept 14 days, longer than the 7-day stream". Nothing in the change deletes `processed_messages` rows, and docs/database does not mention retention.
- **Impact:** The table grows without bound, one row per message per consumer. A reader will assume cleanup exists.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Reword the comment to say retention is not implemented yet and register it as technical debt, or add the cleanup.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#retention-is-documented-but-no-job-exists`
- **History:**
  - 2026-11-03: recorded: MEDIUM maintainability at `packages/db/prisma/schema.prisma:215`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-034: Startup leaks the running relay and consumers if the HTTP server fails to listen

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `apps/worker/src/worker.ts:53`
- **Problem:** The runners and relay are started (lines 40-43) before `server.listen`. A listen error (port in use) is emitted as an unhandled 'error' event and rejects nothing, so there is no cleanup path. `startWorker` also never stops the relay or runners if it throws after they start.
- **Impact:** In embedded or test use the loops keep running against closed resources after a failed start. In main.ts it is an uncaught exception with no graceful drain of in-flight claims.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 46 before deployment; the worker is not deployed, so no failed start has leaked loops in production.
- **Remediation:** Bind the server first and reject on its 'error' event. Start the relay and runners last, or stop them in a catch.
- **Target:** ticket 46 (`issues/46-worker-startup-cleanup.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/worker.ts#startup-leaks-the-running-relay-and-consumers-if-the-http-se`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `apps/worker/src/worker.ts:53`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-04: planned for ticket 46 (`issues/46-worker-startup-cleanup.md`), before ticket 38 (remediation planning, 2026-11-04)

### TD-035: Shutdown has no error handling or timeout

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `apps/worker/src/main.ts:12`
- **Problem:** `shutdown` is an async signal handler with no try/catch. A rejection during `worker.stop()` or `bus.close()` becomes an unhandled rejection and skips `process.exit`, which leaves the process hung or crashing with a misleading status. There is also no bound on how long stop waits for an in-flight 60 s relay transaction.
- **Impact:** A SIGTERM during a slow tick can exceed the orchestrator's kill grace period. Failures in the shutdown path are unreported.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Wrap shutdown in try/catch and set a nonzero exit code on error. Add a deadline after which it exits.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/main.ts#shutdown-has-no-error-handling-or-timeout`
- **History:**
  - 2026-11-03: recorded: LOW defect at `apps/worker/src/main.ts:12`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-036: ensureTopology treats any `add` failure as a config mismatch

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/jetstream-message-bus.ts:112`
- **Problem:** The bare `catch {}` around `streams.add` falls through to `update` for every error, including timeouts, permission failures and invalid config. The update then surfaces a different error and the original cause is lost.
- **Impact:** Startup diagnosis is harder: the reported error describes the update, not the add failure.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Catch only the JetStream 'stream name already in use' error (or look the stream up first) and rethrow anything else.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/jetstream-message-bus.ts#ensuretopology-treats-any-add-failure-as-a-config-mismatch`
- **History:**
  - 2026-11-03: recorded: LOW defect at `packages/messaging/src/jetstream-message-bus.ts:112`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-037: Reflect.get indirection kept after the export exists

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/message-bus.test.ts:36`
- **Problem:** `connectJetStreamMessageBus` is read via `Reflect.get(messaging, ...)` with a cast and a hand-written `BusHandle`/`ConnectBus` type. That was useful while the code was missing, but it now bypasses type checking of the real signature.
- **Impact:** The test compiles even if the factory's signature changes, and it adds noise.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Import `connectJetStreamMessageBus` directly and drop the local types.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/message-bus.test.ts#reflect-get-indirection-kept-after-the-export-exists`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/message-bus.test.ts:36`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-038: A permanently unpublishable row blocks its whole aggregate

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:50`
- **Problem:** A row whose `eventType` maps to a subject outside the stream's subjects (or whose payload cannot be published) fails on every tick. `attempts` grows with no cap or terminal status, and the NOT EXISTS ordering rule then keeps every later row of that aggregate from being claimed.
- **Impact:** One bad event stalls that aggregate's events forever at 250 ms retry churn. There is no alert or dead-letter path.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Define a maximum attempts policy (FAILED status or a DLQ route) or track the gap as technical debt.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#a-permanently-unpublishable-row-blocks-its-whole-aggregate`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/outbox-relay.ts:50`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-039: The same bus and prisma setup is repeated in three test files

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.test.ts:22`
- **Problem:** The `beforeAll`/`afterAll` that creates the prisma client and the prefixed JetStream bus is copied into outbox-relay.test.ts, consumer-runner.test.ts and worker.test.ts.
- **Impact:** A change to the isolation scheme has to be made in several places.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Extract a shared test helper (for example in test-infra or a messaging test-support module).
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.test.ts#the-same-bus-and-prisma-setup-is-repeated-in-three-test-file`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/outbox-relay.test.ts:22`, standards axis (ticket 06 review-3 standards, run 20261103-120228)

### TD-040: AT-31 test does not prove the redelivery was acked as a duplicate

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Escalation:** Acceptance gap: ticket 06 AC9 (AT-31) is approved, but its test proves the redelivery and the single side effect, not the duplicate ack the criterion names. A regression that naks duplicates forever would stay green, and every later consumer (first: ticket 08) relies on this path. Severity kept at MEDIUM as reported; fix before any consumer ships.
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.test.ts:221`
- **Problem:** The test asserts deliveryCounts [1,2], zero messages on the third poll, and one side effect. It never asserts that the second delivery was acked. If the P2002 to AlreadyProcessed mapping broke, the runner would nak with a 1 s delay. The third poll would still usually return 0 messages and side effects would still be 1, so the test would pass. No test pins the unique-violation-to-ack path directly.
- **Impact:** A regression that naks real duplicates forever would stay green, which is a delivery-loop failure in production.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Assert the ack directly, for example with the consumer info (num_ack_pending and num_pending both 0 after the second delivery). Alternatively, record the ack and nak calls on the wrapped message and assert that the second delivery was acked and not nak'd.
- **Target:** ticket 08 (`issues/08-mock-payment-confirms-order.md`), last AC
- **Resolution:** The AT-31 test records every ack and nak the runner issues per delivery and asserts `["ack:1", "ack:2"]` (the first ack is the simulated crash, the second is the duplicate ack, no nak), then reads the consumer info and asserts `num_pending` and `num_ack_pending` are both 0 after the second delivery. With the duplicate branch changed to nak, the test fails.
- **Verification:** `packages/messaging/src/consumer-runner.test.ts::consumer runner acks a redelivery after a crash between commit and ack as a duplicate (AT-31)`
- **Fingerprints:** `packages/messaging/src/consumer-runner.test.ts#at-31-test-does-not-prove-the-redelivery-was-acked-as-a-dupl`
- **History:**
  - 2026-11-03: recorded: MEDIUM missing_test at `packages/messaging/src/consumer-runner.test.ts:221`, spec axis (ticket 06 review-3 spec, run 20261103-120228)
  - 2026-11-03: escalation flagged and planned for ticket 08: the test leaves ticket 06 AC9 partly unproven (acceptance review of ticket 06, 2026-11-03)
  - 2026-11-03: resolved in ticket 08: the AT-31 test now proves the duplicate was acked and nothing is pending
  - 2026-11-03: resolution verified: quality gate green and independent review approved (ticket 08 review-2, run 20261103-160343)

### TD-041: The 250 ms default is asserted only as an exported constant

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/outbox-relay.test.ts:86`
- **Problem:** The test compares DEFAULT_RELAY_INTERVAL_MS to 250. Nothing shows that createOutboxRelay or the worker loop uses the constant as its pacing. The batch default is covered by the 120-row test, but the interval default is not exercised.
- **Impact:** Changing the fallback in outbox-relay.ts to a literal value would not fail any test.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Assert the effective interval, for example with fake timers and a spy on bus.publish that counts ticks, or have the test pass no options and check the pacing.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.test.ts#the-250-ms-default-is-asserted-only-as-an-exported-constant`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `packages/messaging/src/outbox-relay.test.ts:86`, spec axis (ticket 06 review-3 spec, run 20261103-120228)

### TD-042: Per-aggregate ordering (NOT EXISTS older PENDING) is not in the ticket

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:78`
- **Problem:** The claim query adds a self-referencing NOT EXISTS subquery so that only the oldest PENDING row of each aggregate is claimable. This limits throughput to one row per aggregate per tick, and no acceptance criterion asks for it. It is documented and tested, but it is an unrequested design decision that changes the 'batch of 100' semantics when rows share an aggregate.
- **Impact:** Hot aggregates drain at 4 rows per second. The cost is acceptable for the MVP, but the decision was never put to the ticket owner.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Keep it only if an ADR or the spec requires per-aggregate order. Otherwise record it as an explicit decision in the ticket or an ADR.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#per-aggregate-ordering-not-exists-older-pending-is-not-in-th`
- **History:**
  - 2026-11-03: recorded: LOW scope_creep at `packages/messaging/src/outbox-relay.ts:78`, spec axis (ticket 06 review-3 spec, run 20261103-120228)

### TD-043: placeOrder tells the replay result from the fresh result with an `"order" in placed` check

- **Status:** OPEN
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:528`
- **Problem:** The transaction callback returns either an OrderView (idempotent duplicate, line 446) or `{ order, correlationId }` (fresh, line 526). The caller tells them apart with a structural `"order" in placed` check. The two shapes carry no explicit tag. A later field named `order` on OrderView would flip the branch silently.
- **Impact:** A duplicate request that wrongly takes the fresh branch would log a false "order placed" line. One that is misclassified the other way would return the wrapper instead of an OrderView. Only types guard against this, and that guard disappears if either shape changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Return a tagged result such as `{ kind: "created" | "replayed", order, correlationId }` from the transaction. Alternatively log inside a helper that only the fresh path calls.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#placeorder-tells-the-replay-result-from-the-fresh-result-wit`; `packages/booking/src/booking-service.ts#transaction-result-discriminated-by-an-order-in-placed-check`
- **History:**
  - 2026-11-03: recorded: MEDIUM maintainability at `packages/booking/src/booking-service.ts:528`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-03: seen again: LOW maintainability at `packages/booking/src/booking-service.ts:528`, spec axis (ticket 07 review-2 spec, run 20261103-123322)

### TD-044: The message body is JSON-parsed and envelope-validated up to three times per message

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:84`
- **Problem:** `process` calls `parseJson(message.data)` and then `logBindingsFor`, which runs a full envelope safeParse, at line 60. It calls `parseJson` again at line 84, and `createEmitCausedEvent` runs `parseEnvelope` on every `emit`. The outbox relay (`logBindingsFor` on `row.payload`) repeats the pattern.
- **Impact:** Every message pays the parse and validation cost repeatedly. The logging and causation paths could also diverge if one of them changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Parse once per message with `parseEnvelope(parseJson(data))`. Derive the log bindings and the emit cause from that single result.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#the-message-body-is-json-parsed-and-envelope-validated-up-to`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/consumer-runner.ts:84`, standards axis (ticket 07 review-2 standards, run 20261103-123322)

### TD-045: The context-injection test is weak and can leak state

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `apps/web/src/server/logger.test.ts:27`
- **Problem:** The test asserts only `typeof ctx.logger.child === "function"`. That cannot tell an injected boundary logger from any object. It also builds a real Prisma client through `database()` and never disconnects it. `vi.unstubAllEnvs()` runs only after the assertion, so a failure leaves the stubbed env in place for later tests.
- **Impact:** A regression where the context logger stops being the boundary logger (for example the silent logger) would stay green. A failing test can pollute other tests in the file.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Move `vi.unstubAllEnvs()` into `afterEach`. Assert something specific, such as `ctx.logger` being the instance `createWebLogger` built.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/logger.test.ts#the-context-injection-test-is-weak-and-can-leak-state`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/web/src/server/logger.test.ts:27`, standards axis (ticket 07 review-2 standards, run 20261103-123322)

### TD-046: Needless `as Parameters<typeof createConsumerRunner>[0]` cast in the test

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner-logging.test.ts:63`
- **Problem:** The options object is cast to the parameter type although `logger` is a declared option and the handler fits. The recording logger also adds a `debug` method the Logger port lacks. Both look like leftovers from the red phase.
- **Impact:** The cast disables checking of the options shape and hides future signature drift in this test.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Remove the cast and the unused `debug` member so the compiler checks the call.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner-logging.test.ts#needless-as-parameters-typeof-createconsumerrunner-0-cast-in`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/consumer-runner-logging.test.ts:63`, standards axis (ticket 07 review-2 standards, run 20261103-123322)

### TD-047: pino is added with a caret range while the other runtime dependencies are pinned

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `apps/web/package.json:25`
- **Problem:** `"pino": "^10.4.0"` in web and in worker. Every other runtime dependency (`next`, `zod`, `@trpc/*`, `superjson`) uses an exact version. `tsx` is the only caret, and it is a dev tool.
- **Impact:** A reinstall without the lockfile could pull a newer pino minor into production and break the reproducibility the other pins give.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Pin `10.4.0` exactly in both manifests, as with the other runtime dependencies.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/package.json#pino-is-added-with-a-caret-range-while-the-other-runtime-dep`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `apps/web/package.json:25`, standards axis (ticket 07 review-2 standards, run 20261103-123322)

### TD-048: Handler errors are logged whole with no redaction policy

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:92`
- **Problem:** `log.error({ err: error, ... })` serializes the full error, message and stack. Prisma and validation errors can embed query arguments such as the buyer's contact email. The pino loggers are built with no redaction setting.
- **Impact:** Buyer contact details could end up in logs when a handler fails. No test or doc states a policy.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Add a pino `redact` configuration for contact fields in the app loggers, or log only `err.name` and a sanitized message. Document the policy under Logging and ids.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#handler-errors-are-logged-whole-with-no-redaction-policy`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.ts:92`, standards axis (ticket 07 review-2 standards, run 20261103-123322)

### TD-049: Router-to-service logger wiring is not tested

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.spec.json`
- **Components:** `apps/web/src/server/routers/booking.ts:69`
- **Problem:** bookingServiceFor now passes ctx.logger into createBookingService. Every router test injects silentLogger, so nothing proves the booking procedures actually log with the context logger. The logging test calls the service directly.
- **Impact:** Dropping `logger: ctx.logger` from bookingServiceFor would silence all booking logs in web and every test would still pass.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Add one router test that calls booking.holdSeats with a recording logger and asserts the lines carry correlationId and holdId.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/booking.ts#router-to-service-logger-wiring-is-not-tested`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/web/src/server/routers/booking.ts:69`, spec axis (ticket 07 review-2 spec, run 20261103-123322)

### TD-050: Causation is enforced only if handlers use emit

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:83`
- **Problem:** The handler still receives the raw `tx`, so a handler can write an outbox row directly and bypass emit. Only the emit path is tested; nothing detects other writes.
- **Impact:** A future consumer that writes tx.outboxEvent.create itself can emit events with wrong or missing causationId without any test failing.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** State in the handler docs that emit is the only sanctioned way to write events. When the first real consumer lands, add a test of its emitted ids.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#causation-is-enforced-only-if-handlers-use-emit`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.ts:83`, spec axis (ticket 07 review-2 spec, run 20261103-123322)

### TD-051: Provider latency is awaited inside the runner's DB transaction

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `apps/worker/src/payment/payment-handler.ts:53`
- **Problem:** The handler runs inside the runner's interactive Prisma transaction, which already holds the processed_messages insert, and awaits clock.sleep(waitMs) there. Prisma's default interactive-transaction timeout is 5 s, and the runner sets no timeout.
- **Impact:** A configured latencyMs above a few seconds makes the transaction time out, so the message is retried forever. Even short waits hold a pooled connection while idle, which limits throughput. The default (no latency) and the test sleep stub hide this.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 44, ahead of further payment work; the default latency is zero, so nothing affected runs yet.
- **Remediation:** Do the latency wait before the transaction (for example a handler pre-step), or document and enforce a latency bound below the transaction timeout. Add a test with a real sleep close to the timeout.
- **Target:** ticket 44 (`issues/44-payment-latency-outside-the-transaction.md`); must merge before tickets 17 and 27, which are blocked by it, so no further payment or saga work builds on the transaction behaviour
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment/payment-handler.ts#provider-latency-is-awaited-inside-the-runner-s-db-transacti`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `apps/worker/src/payment/payment-handler.ts:53`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-04: planned for ticket 44 (`issues/44-payment-latency-outside-the-transaction.md`), before tickets 17 and 27 (remediation planning, 2026-11-04)

### TD-052: bookingStore and paymentStore are line-for-line copies; service names are listed in two places

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `packages/messaging/src/service-store.ts:55`
- **Problem:** The two stores differ only in the Prisma delegate and the table name. worker.ts separately hard-codes the list ["booking","payment"], and serviceStore picks via a ternary instead of a total map.
- **Impact:** A third service means editing the ServiceName union, the ternary and the worker list, with the Prisma delegate copies drifting. The compiler does not catch a service missing from the worker's list.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Build the stores from a small factory over the delegate accessors. Use a Record<ServiceName, ServiceStore>, and derive the worker's relay list from Object.keys of that record or an exported constant.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/service-store.ts#bookingstore-and-paymentstore-are-line-for-line-copies-servi`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/service-store.ts:55`, standards axis (ticket 08 review-2 standards, run 20261103-160343)

### TD-053: Payment redelivery/poison paths are untested

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `apps/worker/src/payment/payment-handler.test.ts:129`
- **Problem:** The tests cover only the happy path, the +dup@ double emit and the latency wait. There is no test for a redelivered order.placed under a new event id, which hits the (orderId, attemptNo) unique violation, or for an invalid payload.
- **Impact:** The behaviour of the Payment consumer on a repeated order.placed (a transaction failure that retries forever) is unspecified and unproven.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Add a test pinning the intended behaviour: either an idempotent skip when an attempt already exists for the order, or an asserted failure plus the redelivery outcome.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment/payment-handler.test.ts#payment-redelivery-poison-paths-are-untested`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/worker/src/payment/payment-handler.test.ts:129`, standards axis (ticket 08 review-2 standards, run 20261103-160343)

### TD-054: Consumer-info assertion may read the state before the broker has processed the ack

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.test.ts:237`
- **Problem:** The runner's ack is fire-and-forget. The consumer info is read on a new connection straight after the last pollOnce, with no wait for the broker to apply the ack. The ack:2 outcome assertion proves the runner's decision, but num_ack_pending === 0 depends on timing.
- **Impact:** The test could flake under load on the ack-pending assertion. The ack-versus-nak guarantee itself is already proven by the outcomes assertion.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Wrap the info assertions in expect.poll, or flush the connection before reading the info.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.test.ts#consumer-info-assertion-may-read-the-state-before-the-broker`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.test.ts:237`, spec axis (ticket 08 review-2 spec, run 20261103-160343)

### TD-055: CHECK constraint is tested by its definition text, not by its behaviour

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/db/src/payment-schema.test.ts:47`
- **Problem:** The test regex-matches pg_get_constraintdef for 'CAPTURED' and 'capturedAt'. It never inserts a CAPTURED row without capturedAt, or a non-CAPTURED row with capturedAt, to show the database rejects them.
- **Impact:** A wrong CHECK, such as one that enforces only one direction of the equivalence, would still pass.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Insert both violating rows through raw SQL or Prisma and assert each is rejected.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/payment-schema.test.ts#check-constraint-is-tested-by-its-definition-text-not-by-its`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `packages/db/src/payment-schema.test.ts:47`, spec axis (ticket 08 review-2 spec, run 20261103-160343)

### TD-056: Ledger and payment schema carry columns and values beyond the ticket

- **Status:** OPEN
- **Severity:** LOW
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/db/prisma/schema.prisma:251`
- **Problem:** order_payments adds refundRequestedAt and refundAttempts. The disposition enum includes REFUND_REQUESTED, MANUAL_REVIEW and REFUNDED. payment_attempts adds ATTEMPTING and FAILED statuses with a second CHECK. None of these are used by this slice.
- **Impact:** The schema exposes unexercised states, and later tickets may want different shapes. The cost is low because the migration is still unreleased.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Defer the refund columns and the unused statuses to the tickets that use them, or confirm they come from the spec's data model.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#ledger-and-payment-schema-carry-columns-and-values-beyond-th`
- **History:**
  - 2026-11-03: recorded: LOW scope_creep at `packages/db/prisma/schema.prisma:251`, spec axis (ticket 08 review-2 spec, run 20261103-160343)

### TD-057: The sandboxed agent can write the host repository, its Git metadata and the batch state

- **Status:** IN_PROGRESS
- **Severity:** HIGH
- **Escalation:** none
- **Source:** harness preflight before the batch of tickets 09-11 (2026-11-04), not a slice review
- **Evidence:** `scripts/sandbox.sh:51` mounts the whole host repository read-write at `/host-repo`; the agent runs there with `--dangerously-skip-permissions` as the same user as the entrypoint (`scripts/sandbox-entrypoint.sh:38`)
- **Components:** `scripts/sandbox.sh:51`, `scripts/sandbox-entrypoint.sh:38`, `scripts/ralph-batch.mjs:204`
- **Problem:** Only convention keeps the agent in its clone. Through `/host-repo` it can write the host's `.git` (refs, hooks, config), the host working tree (including `scripts/ralph-ci.sh`, `scripts/sandbox.sh` and `ralph-loop.sh`, which the batch runs on the host between tickets) and `.ralph/batch` and `.ralph/state`. The batch accepts a merge on two marks that the agent can write itself: a `Merge slice/<slug>:` commit and an archived `done` ticket on `main`.
- **Impact:** A misbehaving agent could forge a merge that skips review and have the batch push it to GitHub. It could also run code on the host, where `gh` credentials are available, through a hook or `core.fsmonitor`, fake a CI pass by rewriting `ralph-ci.sh`, or forge batch or resume checkpoints. Autonomous production batches are blocked until this is fixed. An audit on 2026-11-04 found no evidence that any of this happened: the host `.git/config` and hooks are clean, there are no symlinks under `.ralph`, and all 15 container pushes to `main` have Ralph's merge or block shape.
- **Justification:** Found before the batch started, and no batch ran. Fixed by ticket 47, which must merge before the next production batch (user decision, 2026-11-04).
- **Remediation:** No host repository mount. Input goes in as a read-only Git bundle and output comes back as a bundle in a per-run directory. A trusted host step validates the bundle and accepts it: merge shape, ticket and dependencies, protected paths, no Git attributes, submodules or symlinks, the gate re-run in an agent-free sandbox, and strict pause validation. Batch and resume state stay host-only. Regression tests cover all four attack paths, including through real Docker.
- **Target:** ticket 47 (`issues/47-sandbox-trust-boundary.md`); must merge before the next production batch (tickets 09-11)
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/sandbox.sh#the-sandboxed-agent-can-write-the-host-repository-its-git-me`
- **History:**
  - 2026-11-04: recorded: HIGH security finding at `scripts/sandbox.sh:51`, harness preflight before the batch of tickets 09-11
  - 2026-11-04: in progress in ticket 47 (`issues/47-sandbox-trust-boundary.md`); autonomous production batches blocked until it merges (user decision, 2026-11-04)
<!-- ralph-debt:end -->
