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
| OPEN          | 0        | 0    | 2      | 15  | 17    |
| PLANNED       | 0        | 0    | 6      | 4   | 10    |
| IN_PROGRESS   | 0        | 0    | 0      | 0   | 0     |
| RESOLVED      | 0        | 0    | 0      | 0   | 0     |
| ACCEPTED_RISK | 0        | 0    | 0      | 0   | 0     |

## Entries

### TD-001: packages/db reads process.env directly

- **Status:** OPEN
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/src/seed-main.ts:6`
- **Problem:** seed-main.ts reads process.env["DATABASE_URL"] inside the db package. The comment justifies it as a CLI boundary, but the documented rule has no exception for package scripts, and the code-review hard rules say a breach is at least HIGH.
- **Impact:** This sets a precedent that weakens the dependency-injection rule. There is no concrete runtime failure, which is why I rate it MEDIUM and not HIGH.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment).
- **Remediation:** Take the URL as a CLI argument, or put the entry point in an app or scripts workspace that validates env. Alternatively, record the CLI-entry exception in CLAUDE.md or an ADR so the rule and the code agree.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/seed-main.ts#packages-db-reads-process-env-directly`
- **History:**
  - 2026-10-30: recorded: MEDIUM architecture at `packages/db/src/seed-main.ts:6`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

### TD-002: Venue seeding is check-then-create on a non-unique column

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/seed.ts#venue-seeding-is-check-then-create-on-a-non-unique-column`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/db/src/seed.ts:53`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)

### TD-003: Every request now requires DATABASE_URL, even procedures that do not use the db

- **Status:** OPEN
- **Severity:** MEDIUM
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/trpc.ts:36`
- **Problem:** createTRPCContext calls database(), which parses DATABASE_URL, for every request. health.check and session.whoami never touch the db.
- **Impact:** A missing or invalid DATABASE_URL turns the health check and whoami into 500s. A liveness probe then cannot tell a running process from an unreachable database. The env error also appears on unrelated routes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment).
- **Remediation:** Make ctx.db a lazy accessor (for example a getter or `db: () => PrismaClient`) that is evaluated only by procedures that need it, or add a separate readiness check so that health.check stays independent of the database.
- **Target:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/trpc.ts#every-request-now-requires-database-url-even-procedures-that`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `apps/web/src/server/trpc.ts:36`, standards axis (ticket 03 review-2 standards, run 20261030-132411)

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

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/migrations/20261030010000_holds/migration.sql#no-index-on-seats-holdid-which-is-now-a-foreign-key-and-a-lo`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/db/prisma/migrations/20261030010000_holds/migration.sql:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)

### TD-013: Lazy hold expiry is not implemented; expired holds block seats until a sweeper exists

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Escalation:** Business impact is HIGH for any real on-sale: every abandoned hold makes its seats unsellable for good. Ticket 14 must merge before any deployment (ticket 38).
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

### TD-014: Duplicate seat ids are not rejected at the service level

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#duplicate-seat-ids-are-not-rejected-at-the-service-level`
- **History:**
  - 2026-10-30: recorded: LOW defect at `packages/booking/src/booking-service.ts:74`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)

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

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#order-lines-priced-from-a-different-seat-set-than-the-one-va`
- **History:**
  - 2026-10-30: recorded: MEDIUM defect at `packages/booking/src/booking-service.ts:386`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: escalation flagged (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)

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
- **Fingerprints:** `packages/booking/src/booking-service.ts#pg-unique-violation-holds-a-prisma-error-code`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:124`, standards axis (ticket 05 review-2 standards, run 20261030-135423)

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

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#hard-coded-eur-fallback-and-repeated-inline-line-shape`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:390`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`) (correctness review of tickets 03-05, 2026-10-30)

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

- **Status:** PLANNED
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
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
<!-- ralph-debt:end -->
