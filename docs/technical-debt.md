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
  changed and `Verification` names the test that proves it (`` `path::test name` ``; every path
  named must be an existing test file the gate runs). Reviewers check the claim; Ralph adds a `resolution verified` history line when the
  slice merges. No deadline is ever invented: `Target` names a ticket or stays `none`.
- **Triage.** A human classifies every finding: `Risk` (`CORRECTNESS`, `CONCURRENCY`,
  `SECURITY`, `VERIFICATION`, `OPERABILITY`, `MAINTAINABILITY`; `UNTRIAGED` until then),
  `Triage` (`YYYY-MM-DD: <who decided, and where>`; `pending` until then), an owner
  (`Target: ticket NN`, required for `MEDIUM` and worse) and the tickets it `Blocks` (`none`, or
  ticket numbers that rely on the fixed behaviour). Risk and blocking are separate decisions:
  a `LOW` blocks only the tickets listed in `Blocks`. The [debt gate](adr/0016-risk-based-debt-gate.md)
  holds a ticket that a blocking entry names, every ticket while a `MEDIUM`+ entry is untriaged
  or unowned, and every ticket that builds on the ticket an untriaged `LOW` was found in. The
  owner ticket cannot merge until the entry is `RESOLVED`.
- **Accepting a risk.** `ACCEPTED_RISK` is a deliberate human decision, never a default: it is
  triaged, blocks nothing, and its `Acceptance` states `Residual risk:`, `Review when:` and
  `Decided by:`.
- **Who may change what.** A slice may only resolve entries (and Ralph's recorder adds or
  reopens them, untriaged); the host refuses any other change. Maintainers change triage in a
  reviewed commit that adds a history line saying who decided and why (`ralph-debt.mjs audit`,
  run in CI). Unresolved entries may not name done or missing tickets: reconcile them.
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
| OPEN          | 0        | 0    | 0      | 48  | 48    |
| PLANNED       | 0        | 0    | 13     | 18  | 31    |
| IN_PROGRESS   | 0        | 0    | 0      | 0   | 0     |
| RESOLVED      | 0        | 3    | 7      | 6   | 16    |
| ACCEPTED_RISK | 0        | 0    | 0      | 0   | 0     |

| Risk            | OPEN | PLANNED | IN_PROGRESS | RESOLVED | ACCEPTED_RISK | Total |
| --------------- | ---- | ------- | ----------- | -------- | ------------- | ----- |
| CORRECTNESS     | 2    | 5       | 0           | 5        | 0             | 12    |
| CONCURRENCY     | 0    | 2       | 0           | 2        | 0             | 4     |
| SECURITY        | 1    | 2       | 0           | 2        | 0             | 5     |
| VERIFICATION    | 10   | 14      | 0           | 5        | 0             | 29    |
| OPERABILITY     | 7    | 7       | 0           | 2        | 0             | 16    |
| MAINTAINABILITY | 25   | 1       | 0           | 0        | 0             | 26    |
| UNTRIAGED       | 3    | 0       | 0           | 0        | 0             | 3     |

## Entries

### TD-001: packages/db reads process.env directly

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/src/seed-main.ts:6`
- **Problem:** seed-main.ts reads process.env["DATABASE_URL"] inside the db package. The comment justifies it as a CLI boundary, but the documented rule has no exception for package scripts, and the code-review hard rules say a breach is at least HIGH.
- **Impact:** This sets a precedent that weakens the dependency-injection rule. There is no concrete runtime failure, which is why I rate it MEDIUM and not HIGH.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment). Triage 2026-11-06: breaks the dependency-injection rule without a runtime failure; deployment (38) must not ship a package that reads the environment.
- **Remediation:** Take the URL as a CLI argument, or put the entry point in an app or scripts workspace that validates env. Alternatively, record the CLI-entry exception in CLAUDE.md or an ADR so the rule and the code agree.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Blocks:** 38
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/seed-main.ts#packages-db-reads-process-env-directly`
- **History:**
  - 2026-10-30: recorded: MEDIUM architecture at `packages/db/src/seed-main.ts:6`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38 (user decision, 2026-11-03)
  - 2026-11-06: triaged: MAINTAINABILITY, owned by ticket 43, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-002: Venue seeding is check-then-create on a non-unique column

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** CONCURRENCY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/src/seed.ts:53`
- **Problem:** Venues are found with findFirst by name and created if absent, but venues.name has no unique constraint. Sections, rows and events use upserts on unique keys, so venue is the only entity whose idempotency depends on a non-atomic check.
- **Impact:** Two concurrent `db:seed` runs (for example parallel deploy jobs) can both miss and both create 'Arena Central'. Duplicate venues then survive. Later findFirstOrThrow calls on the venue name pick an arbitrary one, so events and sections can attach to different copies, and the docs claim idempotency.
- **Justification:** Only concurrent seed runs trigger it, and no deployment runs the seed yet; fixed before ticket 38 (deployment) can run seeds from deploy hooks.
- **Remediation:** Add @@unique on Venue.name (with a migration) and use upsert with update: {} like the other entities.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/trpc.ts:36`
- **Problem:** createTRPCContext calls database(), which parses DATABASE_URL, for every request. health.check and session.whoami never touch the db.
- **Impact:** A missing or invalid DATABASE_URL turns the health check and whoami into 500s. A liveness probe then cannot tell a running process from an unreachable database. The env error also appears on unrelated routes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review; config-injection debt, revisit before ticket 38 (deployment). Triage 2026-11-06: a health check that fails with the database misleads a liveness probe; that matters first at deployment (38).
- **Remediation:** Make ctx.db a lazy accessor (for example a getter or `db: () => PrismaClient`) that is evaluated only by procedures that need it, or add a separate readiness check so that health.check stays independent of the database.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Blocks:** 38
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/trpc.ts#every-request-now-requires-database-url-even-procedures-that`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `apps/web/src/server/trpc.ts:36`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38 (user decision, 2026-11-03)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 43, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-004: Module-level mutable singleton hides the client lifecycle

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/trpc.ts:24`
- **Problem:** sharedDb is mutable module state created inside trpc.ts. It has no way to be replaced or disconnected, and the driver is hard-coded to "neon".
- **Impact:** Nothing can swap the client or close it in tests. Hot-reload behaviour in dev is untested. This is minor and the comment explains why.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: a module singleton; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Acceptable for this ticket. If more infrastructure joins the context, move construction into a small composition-root module that createTRPCContext receives.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/trpc.ts#module-level-mutable-singleton-hides-the-client-lifecycle`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/trpc.ts:24`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-005: unusedDb helper duplicated across test files, built from a fake URL

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/health.test.ts:6`
- **Problem:** The same unusedDb factory, with the same fake connection string and comment, is copied into health.test.ts and session.test.ts. The tests also rely on the client never connecting, which is an unstated assumption of the driver.
- **Impact:** A change to the client factory or to its lazy-connect behaviour must be fixed in several places. A driver that connects eagerly would make these unrelated tests fail.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: duplicated test helper; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Share a single helper, for example in a test-support module, or let these tests use the real test database like catalog.test.ts does.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/health.test.ts#unuseddb-helper-duplicated-across-test-files-built-from-a-fa`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/routers/health.test.ts:6`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-006: Seat-map tests depend on execution order and shared mutated state

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/catalog.test.ts:99`
- **Problem:** The first seats.map test asserts that map.seats[0] has status AVAILABLE. A later test marks an arbitrary findFirst seat as SOLD in the same shared database. Nothing pins the seat updated to a position other than the first. seed.test.ts has the same pattern: an earlier test asserts all statuses are AVAILABLE, and a later one writes SOLD.
- **Impact:** Reordering tests, or a Prisma default ordering change, makes them fail or pass for the wrong reason. The suite is currently green only because of declaration order.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: the seat-map tests depend on declaration order; the seat-map UI (32) builds on the API, whose behaviour other tests pin, not on these tests' order.
- **Remediation:** Make each test create its own fixture state, or reset it in beforeEach (reseed or delete). Choose the SOLD seat explicitly, for example the last one in the map order.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/catalog.test.ts#seat-map-tests-depend-on-execution-order-and-shared-mutated-`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `apps/web/src/server/routers/catalog.test.ts:99`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-007: tsx is added with a caret range

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `packages/db/package.json:27`
- **Problem:** The new devDependency is "tsx": "^4.23.15", while every other dependency in the manifest is pinned exactly.
- **Impact:** The version drifts between installs without a lockfile update. The impact is small because the lockfile pins it.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: the lockfile pins the dev tool; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Pin it as "tsx": "4.23.15".
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/package.json#tsx-is-added-with-a-caret-range`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/db/package.json:27`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-008: Alias exports and unconstrained money and currency fields

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.standards.json`
- **Components:** `apps/web/src/server/routers/catalog-schemas.ts:5`
- **Problem:** eventInput and seatMapInput are aliases of the same schema. currency is `z.string().length(3)` and Section.currency is a free-form String in the DB, although the ticket fixes the currency at EUR. The migration has no CHECK on priceMinor >= 0.
- **Impact:** The API contract and DB do not enforce the 'EUR, integer minor units, non-negative' rule that the ticket describes. A bad seed or manual write would pass through.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: only seed data or a manual write can store a non-EUR currency or a negative price; no unfinished ticket writes prices.
- **Remediation:** Use `z.literal("EUR")` or an enum for currency, and a DB CHECK for priceMinor >= 0. A single shared input schema would do instead of the aliases.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/catalog-schemas.ts#alias-exports-and-unconstrained-money-and-currency-fields`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `apps/web/src/server/routers/catalog-schemas.ts:5`, standards axis (ticket 03 review-2 standards, run 20261030-132411)
  - 2026-11-06: triaged: CORRECTNESS, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-009: multiSchema configuration is not asserted by any test

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-2.spec.json`
- **Components:** `packages/db/prisma/schema.prisma:10`
- **Problem:** The datasource sets schemas = ["public"] and every model and enum has @@schema("public"), but no test checks this. The catalog tests would pass if multiSchema were removed.
- **Impact:** A later edit could drop the multiSchema setup without any test failing; the risk is low.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: dropping multiSchema would fail every @@schema model at generate time; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Add a cheap check, e.g. a test that reads schema.prisma for the schemas setting, or asserts that the tables and the SeatStatus type live in the public schema via information_schema.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#multischema-configuration-is-not-asserted-by-any-test`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/db/prisma/schema.prisma:10`, spec axis (ticket 03 review-2 spec, run 20261030-132411)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-010: seedCatalog is exported from the runtime barrel of @ticketarena/db

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-1.standards.json` (round 1; not repeated in the approved round 2, still present)
- **Components:** `packages/db/src/index.ts:19`
- **Problem:** seedCatalog is re-exported from the db barrel that the web app imports at runtime, so demo-catalog data and seeding logic sit in the production server module graph although only tests and the CLI need them.
- **Impact:** A wider public surface than the API needs, and a request path could call the seeder by accident.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed. Triage 2026-11-06: a wider export surface; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Expose the seeder through a separate entry point (e.g. a `./seed` export) used only by tests and the CLI.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-011: The db:seed entry point is not exercised by any test

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 03 (`03-seeded-catalog-and-seat-map-api`)
- **Evidence:** `.ralph/logs/20261030-132411/03-seeded-catalog-and-seat-map-api.review-1.spec.json` (round 1; still present)
- **Components:** `packages/db/src/seed-main.ts:6`
- **Problem:** Tests call seedCatalog directly; the script `pnpm db:seed` runs (env guard, driver choice, disconnect) is never executed by the suite.
- **Impact:** A broken entry point passes the gate and fails only when someone seeds a database.
- **Justification:** LOW and dev-only today. Best fixed together with TD-001, which moves the entry point to a boundary that validates config. Triage 2026-11-06: a broken seed entry point fails loudly when run, never silently; no unfinished ticket relies on the affected behaviour.
- **Remediation:** When TD-001 moves the CLI to an app boundary, test it end to end against the test database.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-012: No index on seats.holdId, which is now a foreign key and a lookup key

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/db/prisma/migrations/20261030010000_holds/migration.sql:22`
- **Problem:** The migration adds the FK seats.holdId -> holds.id with ON DELETE SET NULL and no index on holdId. getHold includes seats by holdId, and any later hold delete, release or expiry will filter or cascade on it.
- **Impact:** On a large seats table, every getHold does a sequential scan of seats. Hold-lifecycle updates do the same, and they run while seat row locks are held. That adds latency and lock time on the hot path during a sale spike.
- **Justification:** Seat tables are small until load tests; fixed before ticket 39 (load tests) exercises getHold and expiry at scale.
- **Remediation:** Add @@index([holdId]) to Seat in schema.prisma and CREATE INDEX "seats_holdId_idx" ON "seats"("holdId") in the migration.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** Booking-correctness risk. Business impact is HIGH for any real on-sale: every abandoned hold makes its seats unsellable for good. No release that depends on expired seats becoming available again may ship before ticket 14 merges and its tests (AT-07: an expired hold's seat can be held by another buyer before the sweeper runs) pass; ticket 38 (deployment) is blocked by ticket 14.
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`; `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.spec.json`
- **Components:** `packages/booking/src/booking-service.ts:73`, `packages/db/prisma/schema.prisma:143`
- **Problem:** Only seats with status === "AVAILABLE" are accepted. The Hold model comment says a HELD seat with an expired hold is treated as free at decision time, and ADR 0005 says the same, but nothing here implements it. Nothing else in this slice resets expired holds.
- **Impact:** Abandoned holds keep their seats unsellable forever until a later slice adds expiry. The comment misleads readers. The decidedAt-after-lock design is also only half used, because it is never compared with an existing hold's expiry.
- **Justification:** Ticket 14 implements lazy expiry and the sweeper as specified in ADR 0005; nothing is deployed, so no real seat is blocked yet. Triage 2026-11-06: abandoned holds make seats unsellable; ticket 15 already builds on ticket 14, and deployment (38) must wait for the fix.
- **Remediation:** Either implement the ADR rule (join holds and treat HELD with holdExpiresAt <= decidedAt as free, then re-claim), or remove the lazy-expiry claim from the schema comment and record it as deferred to the expiry ticket.
- **Target:** ticket 14 (`issues/14-hold-expiry.md`), AC1 and AC7
- **Blocks:** 38
- **Acceptance:** none
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
  - 2026-11-05: when ticket 14 lands, the expired HELD seat becomes holdable, so TD-066's Verification test `hold-fast-path.test.ts::an expired HELD seat refused under the lock counts seat_unavailable, not race_lost` must be replaced by a refusal of an unchanged seat that does not rely on this gap
  - 2026-11-06: triaged: CORRECTNESS, owned by ticket 14, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-014: Duplicate seat ids are not rejected at the service level

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:74`
- **Problem:** seatIds containing the same id twice locks one row. The free set contains it, so the check passes. The envelope and HoldView then repeat the id, and the router's length(1) currently hides this. The service also has no min-length check, and an empty array would create a hold with no seats and fail at envelope.parse (min(1)) only after the hold row has been written, which rolls back.
- **Impact:** This is latent. It becomes reachable when the 6-seat limit lands and the router guard is relaxed.
- **Justification:** Unreachable today: the router accepts exactly one seat id. Must be closed before ticket 11 relaxes the router to 1-6 seats.
- **Remediation:** Dedupe or reject duplicate and empty seatIds at the start of holdSeats, and add a test.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/contracts/src/envelope.ts:22`
- **Problem:** Envelope<Payload> restates every field of envelopeSchema by hand instead of deriving it from the schema, so the two can drift.
- **Impact:** A field added to the schema without updating the type goes unnoticed by consumers.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: type duplication; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Derive it with z.infer<ReturnType<typeof envelopeSchema<Payload>>>, or drop the type until a consumer needs it.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/contracts/src/envelope.ts#envelope-type-hand-duplicates-the-schema-shape`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/contracts/src/envelope.ts:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-016: Clock-after-lock test depends on sleeps

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: user decision to split ticket 12 after two rejected runs; owner moved to ticket 55
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.test.ts:130`
- **Problem:** The test sleeps 100 ms and then 300 ms to order a blocker transaction against the service call. If holdSeats starts before the blocker locks, or the blocker commits before the clock is read, the result depends on timing. lockHeld is also cleared just before the transaction commits, not after.
- **Impact:** The test can flake on a slow CI machine. It can also pass in the window between the flag flip and the commit, even if the clock were read before the lock was acquired.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: the clock-after-lock test relies on sleeps; ticket 12 (now ticket 55) changes the locking transactions it guards, so it owns this.
- **Remediation:** Synchronise on events instead of timers, for example poll pg_locks or pg_stat_activity until the service is waiting. Record the clock read order against a flag that is set only after the blocker has committed.
- **Target:** ticket 55 (`issues/55-deterministic-transaction-tests.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.test.ts#clock-after-lock-test-depends-on-sleeps`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/booking-service.test.ts:130`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 12, blocks no ticket (initial triage, ticket 53)
  - 2026-11-06: re-planned for ticket 55 (`issues/55-deterministic-transaction-tests.md`): ticket 12 was split into tickets 54-57 after rejected runs 20261106-132615 and 20261106-165157 (user decision, 2026-11-06)

### TD-017: HoldStatus and the status enum are duplicated across layers

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:22`
- **Problem:** The HoldStatus union is redeclared in the service, and the router's holdOutput repeats the status enum literals, although @ticketarena/db already exports HoldStatus.
- **Impact:** A status added to the Prisma enum must be edited in three places.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: enum duplication the compiler partly checks; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Reuse the HoldStatus type exported by @ticketarena/db in the service and derive the router enum from one shared constant.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#holdstatus-and-the-status-enum-are-duplicated-across-layers`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:22`, standards axis (ticket 04 review-1 standards, run 20261030-134316)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-018: Atomicity not tested on a failure after the writes begin

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: user decision to split ticket 12 after two rejected runs; owner moved to ticket 55
- **Escalation:** none
- **Source:** ticket 04 (`04-hold-one-seat`)
- **Evidence:** `.ralph/logs/20261030-134316/04-hold-one-seat.review-1.spec.json`
- **Components:** `packages/booking/src/booking-service.test.ts:91`
- **Problem:** The only rollback-style test fails at the availability check, before any write. No test shows that a failure after the hold or seat update (for example an outbox write failure) leaves nothing behind.
- **Impact:** A refactor that moved the outbox write outside the transaction would still pass the suite, losing the "event exists iff the hold committed" guarantee.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: nothing proves a failure after the writes begin leaves no partial hold; ticket 12 (now ticket 55) retries whole transactions, which relies on that atomicity, so it owns this.
- **Remediation:** Add a test that makes the outbox insert fail (for example a duplicate envelope id from a fixed newId) and asserts that no hold exists and the seat is still AVAILABLE.
- **Target:** ticket 55 (`issues/55-deterministic-transaction-tests.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.test.ts#atomicity-not-tested-on-a-failure-after-the-writes-begin`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/booking-service.test.ts:91`, spec axis (ticket 04 review-1 spec, run 20261030-134316)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 12, blocks no ticket (initial triage, ticket 53)
  - 2026-11-06: re-planned for ticket 55 (`issues/55-deterministic-transaction-tests.md`): ticket 12 was split into tickets 54-57 after rejected runs 20261106-132615 and 20261106-165157 (user decision, 2026-11-06)

### TD-019: Order lines priced from a different seat set than the one validated

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** Money correctness: the amount charged (order.placed amountMinor, consumed by ticket 08) can differ from the validated, locked seat set, and an unlocked seat row can be mutated.
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:386`
- **Problem:** The validated and locked seat set is `expectedSeatIds` from the seat.held event. The price query and the `seat.updateMany` select seats with `WHERE holdId = ...` instead. If a seat carries this holdId but is not in the event's seat set, it is not locked or validated, yet it is priced into the order and set to IN_CHECKOUT.
- **Impact:** The total and the lines can diverge from what was validated, and a seat that was never locked can be mutated. This needs corrupted data, so the chance is low, but the code gives no guarantee against it.
- **Justification:** Needs a seat whose holdId disagrees with the hold's seat.held set, which no current code path produces; fixed before ticket 08 charges the order total.
- **Remediation:** Price by `id = ANY(expectedSeatIds)`, and update seats by the same id list with a `status = HELD` guard, so lines, total and mutation all use the one locked set.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** CONCURRENCY
- **Triage:** 2026-11-06: user decision to split ticket 12 after two rejected runs; owner moved to ticket 54
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:351`
- **Problem:** The transaction runs with Prisma's default interactive-transaction timeout. It sets no lock_timeout or statement_timeout, and it does not retry deadlocks or serialization failures. The router passes unknown errors through unchanged.
- **Impact:** When the seats are contended, a buyer gets an opaque INTERNAL_SERVER_ERROR after the transaction times out. A deadlock or timeout is never retried. This extends a gap that already exists in holdSeats.
- **Justification:** Ticket 12 implements ADR 0005's timeouts, retry and BOOKING_BUSY for every booking transaction; contention only occurs under load, which ticket 10 introduces first. Triage 2026-11-06: contended booking transactions fail opaquely and never retry; the load tests (39) measure exactly that path.
- **Remediation:** Apply the ADR 0005 timeouts and bounded retry to the booking transactions. If that is deferred to another ticket, record it as a known limitation in docs/database/index.md.
- **Target:** ticket 54 (`issues/54-transaction-timeouts-and-retries.md`)
- **Blocks:** 39
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#placeorder-has-no-lock-timeout-retry-or-booking-busy-mapping`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `packages/booking/src/booking-service.ts:351`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 12 (`issues/12-lock-timeout-and-deadlock-retry.md`) (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: CONCURRENCY, owned by ticket 12, blocks ticket(s) 39 until it is resolved (initial triage, ticket 53)
  - 2026-11-06: re-planned for ticket 54 (`issues/54-transaction-timeouts-and-retries.md`): ticket 12 was split into tickets 54-57 after rejected runs 20261106-132615 and 20261106-165157 (user decision, 2026-11-06)

### TD-021: PG_UNIQUE_VIOLATION holds a Prisma error code

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:124`
- **Problem:** `P2002` is Prisma's unique-constraint error code. The Postgres SQLSTATE for a unique violation is 23505, so the name points at the wrong layer.
- **Impact:** A reader may assume raw Postgres errors are handled here. A driver-adapter change could break the check without anyone noticing.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. No correctness impact found in the 2026-10-30 correctness review. Triage 2026-11-06: a misleading constant name; the driver adapter is fixed by the base (ADR 0015), so the check cannot silently break; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Rename it to `PRISMA_UNIQUE_CONSTRAINT`. Alternatively also recognise `meta`/SQLSTATE 23505 for the driver-adapter case.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#pg-unique-violation-holds-a-prisma-error-code`; `packages/messaging/src/consumer-runner.ts#pg-unique-violation-holds-prisma-s-p2002-again`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:124`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-11-03: seen again: LOW maintainability at `packages/messaging/src/consumer-runner.ts:5`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-022: Racing-duplicate test checks only the returned order ids

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/place-order.test.ts:123`
- **Problem:** The 5-way race asserts that the returned ids are equal. It does not assert that exactly one order row, one order.placed outbox row and one set of lines exist.
- **Impact:** The test still passes if a losing request wrote a duplicate outbox event or lines and returned the winner's order.
- **Justification:** Ticket 16 hardens checkout idempotency; its AT-12 asserts one order for concurrent duplicates. Triage 2026-11-06: the race test checks returned ids only; ticket 16 owns it (AT-12) and nothing else relies on it.
- **Remediation:** Count `order` rows and `outboxEvent` rows for the hold and the order id, and expect 1 of each.
- **Target:** ticket 16 (`issues/16-checkout-idempotency-hardening.md`), AT-12
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/place-order.test.ts#racing-duplicate-test-checks-only-the-returned-order-ids`
- **History:**
  - 2026-10-30: recorded: LOW missing_test at `packages/booking/src/place-order.test.ts:123`, standards axis (ticket 05 review-2 standards, run 20261030-135423)
  - 2026-10-30: planned for ticket 16 (`issues/16-checkout-idempotency-hardening.md`), AT-12 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 16, blocks no ticket (initial triage, ticket 53)

### TD-023: Hard-coded EUR fallback and repeated inline line shape

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:390`
- **Problem:** `priced[0]?.currency ?? "EUR"` invents a currency that no input supports. The `{ seatId; priceMinor; currency }` line shape is repeated inline in OrderView and in the toOrderView parameter.
- **Impact:** If the unreachable branch is ever reached, it silently writes a made-up currency. The repeated shape invites drift.
- **Justification:** Unreachable while every section is EUR; fixed with TD-019 because the same code computes the total.
- **Remediation:** Throw on an empty priced set rather than defaulting. Define one `OrderLineView` type and use it in both places.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present)
- **Components:** `packages/booking/src/booking-service.ts:161`
- **Problem:** When the seat set is empty and no seat is lost, `new SeatUnavailableError([])` is thrown; its message names no seat, hiding the real cause (a hold without seats).
- **Impact:** A misleading CONFLICT for a corrupted hold that is hard to diagnose.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed. Triage 2026-11-06: a misleading message for a corrupted hold; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Throw a distinct error (or message) for a hold with no seats.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-025: placeOrder is one long method

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present)
- **Components:** `packages/booking/src/booking-service.ts:342`
- **Problem:** Replay fast path, lock sequence, validation, pricing, order creation, state transitions, outbox write and unique-violation recovery are all inline in one closure method.
- **Impact:** Hard to read and review; the order-sensitive lock section is buried among the other steps, which raises the risk of the lock-order regressions ADR 0005 forbids.
- **Justification:** LOW: maintainability or diagnosability only, no correctness impact. Deferred under the merge policy; fix when the file is next changed. Triage 2026-11-06: a long method; the lock order it contains is proven by tests (TD-026); no unfinished ticket relies on the affected behaviour.
- **Remediation:** Extract the locked section and the order construction into named functions while tickets 11, 12 and 14 change this method.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-026: placeOrder skips the buyer advisory lock of ADR 0005's lock order

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** CONCURRENCY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 05 (`05-place-order`)
- **Evidence:** `.ralph/logs/20261030-135423/05-place-order.review-1.standards.json` (round 1; still present: no advisory lock in packages/booking)
- **Components:** `packages/booking/src/booking-service.ts:342`
- **Problem:** ADR 0005 orders locks as buyer advisory lock, hold, order, seats; holdSeats and placeOrder start at the seat or hold row. Harmless while no limit is enforced, but undocumented.
- **Impact:** When ticket 11 adds the buyer lock, any path that takes it after a row lock can deadlock against one that takes it first.
- **Justification:** The advisory lock serializes the per-event buyer limit, which arrives with ticket 11; its AC2 makes placeOrder take the same lock first.
- **Remediation:** Take pg_advisory_xact_lock(hash(eventId:buyerKey)) first in holdSeats and placeOrder, as ticket 11 AC2 specifies, with a test that races the two paths.
- **Target:** ticket 11 (`issues/11-multi-seat-holds-and-buyer-limit.md`), AC2
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** Ticket 11 made `lockBuyer` (`pg_advisory_xact_lock(hashtextextended(eventId:buyerKey))`) the first statement of the locking transaction in both holdSeats and placeOrder, before the hold row and the seats by id. Tests now prove the order through Postgres itself: while a foreign transaction holds the buyer lock, each request is observed waiting on an advisory lock (`pg_locks` / `pg_blocking_pids`) and the hold row and seat rows it will need can still be locked `NOWAIT`. A hold and an order of one buyer started together both queue on the buyer lock and serialize; each test case fixes which of the two queues first, both orders are run, and each gives the same outcome with no partial hold (a refused hold leaves its seats AVAILABLE, unclaimed and without a hold row).
- **Verification:** `packages/booking/src/hold-buyer-limit.test.ts::holdSeats waits on the buyer lock before touching any seat row`; `packages/booking/src/hold-buyer-limit.test.ts::placeOrder waits on the buyer lock before locking the hold or its seats`; `packages/booking/src/hold-buyer-limit.test.ts::a hold of 1 seats and the order of a 1-seat hold queue on the buyer lock, order first (limit refused: false)`; `packages/booking/src/hold-buyer-limit.test.ts::a hold of 1 seats and the order of a 1-seat hold queue on the buyer lock, hold first (limit refused: false)`; `packages/booking/src/hold-buyer-limit.test.ts::a hold of 3 seats and the order of a 4-seat hold queue on the buyer lock, order first (limit refused: true)`; `packages/booking/src/hold-buyer-limit.test.ts::a hold of 3 seats and the order of a 4-seat hold queue on the buyer lock, hold first (limit refused: true)`
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-11-06: resolved on branch `fix/buyer-lock-order-tests` (human commit after ticket 11): the code fix landed with ticket 11 (8aeebeb); the tests above fail if holdSeats or placeOrder skips the buyer lock, and if placeOrder takes it after the hold row lock (mutation checks)
  - 2026-11-06: resolution verified: quality gate green and independent review approved (fix/buyer-lock-order-tests confirmation review, run a2ba22b)

### TD-027: placeOrder fails with an unhandled error once the hold's seat.held outbox row is gone

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** correctness review of tickets 03-05, 2026-10-30 (ticket 05 code)
- **Evidence:** `packages/booking/src/booking-service.ts:368` reads the seat set from the `seat.held` outbox row; `docs/specs/ticketarena-mvp.md:334` deletes outbox rows after 14 days
- **Components:** `packages/booking/src/booking-service.ts:368`, `packages/booking/src/booking-service.ts:371`
- **Problem:** The seat set of a hold is parsed from its `seat.held` outbox event before the hold's status and expiry are checked. A missing row makes `heldEnvelope.parse(undefined)` throw a ZodError, which the router passes through as INTERNAL_SERVER_ERROR.
- **Impact:** After outbox retention (14 days) a placeOrder on an old hold returns a 500 instead of HOLD_NOT_ACTIVE / HOLD_EXPIRED, and business logic depends on an integration log that ticket 06 starts to manage.
- **Justification:** No outbox row is deleted yet (no relay or retention job exists before ticket 06); fixed before the retention job can exist.
- **Remediation:** Refuse a non-HELD hold before reading the event, and map a missing seat.held event to a domain error instead of a 500, with a test.
- **Target:** ticket 41 (`issues/41-booking-and-catalog-correctness-fixes.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** `placeOrder` refuses a non-HELD hold before reading the event and maps a missing `seat.held` event to `HoldSeatSetMissingError` (router `CONFLICT`).
- **Verification:** `packages/booking/src/place-order.test.ts::placeOrder acceptance: lock order and consistency a HELD hold whose seat.held event is gone is a domain error`
- **Fingerprints:** none
- **History:**
  - 2026-10-30: backfilled from an earlier review round; confirmed still present on main at 2513586 (correctness review of tickets 03-05, 2026-10-30)
  - 2026-10-30: resolution verified: quality gate green and independent review approved (ticket 41 review-1, run 20261030-175150)

### TD-028: Unique index on venues.name fails if duplicate venues already exist

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 41 (`41-booking-and-catalog-correctness-fixes`)
- **Evidence:** `.ralph/logs/20261030-175150/41-booking-and-catalog-correctness-fixes.review-1.standards.json`
- **Components:** `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql:2`
- **Problem:** The migration creates a UNIQUE INDEX on venues(name) without removing duplicates first. The old seed was a check-then-create on a non-unique column (TD-002), and that race is the reason for this fix. A database where concurrent seed runs already inserted duplicate venues cannot take the migration.
- **Impact:** prisma migrate deploy fails on such a database and blocks the deploy. The Ticket 38 deploy hooks that run seeds could hit this. Once the index exists the problem cannot recur.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the unique-index migration fails on a database with duplicate venues, which only a deployment (38) can hit.
- **Remediation:** The migration must succeed on a database that already holds duplicate venue names, even though none is known to exist: before CREATE UNIQUE INDEX, keep one venue per name (a documented, deterministic survivor rule) and repoint its duplicates' sections and events to it. Failing early with a message alone is not enough. Prove it with an integration test that migrates a database seeded with duplicates.
- **Target:** ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), AC3 and AC4; must merge before ticket 38 (deployment), which is blocked by it
- **Blocks:** 38
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql#unique-index-on-venues-name-fails-if-duplicate-venues-alread`
- **History:**
  - 2026-10-30: recorded: MEDIUM regression_risk at `packages/db/prisma/migrations/20261030030000_venue_name_unique_seat_hold_index/migration.sql:2`, standards axis (ticket 41 review-1 standards, run 20261030-175150)
  - 2026-11-03: planned for ticket 43 (`issues/43-config-injection-and-venue-migration-hardening.md`), before ticket 38; remediation narrowed to merging duplicates (user decision, 2026-11-03)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 43, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-029: MixedCurrencyError doubles as the empty-set error

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 41 (`41-booking-and-catalog-correctness-fixes`)
- **Evidence:** `.ralph/logs/20261030-175150/41-booking-and-catalog-correctness-fixes.review-1.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:215`
- **Problem:** priceSeats throws MixedCurrencyError when the priced set is empty. The message is then 'seats are priced in ' with nothing after it, and the error name does not describe the problem. This also leaves the empty case with no test.
- **Impact:** If the unreachable branch is ever reached (for example a seat row vanishing between the lock and the pricing), the client gets a misleading MIXED_CURRENCY CONFLICT and the logs point at the wrong cause.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a misleading error on an unreachable branch; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Throw a distinct error (or SeatUnavailableError) for an empty priced set, and keep MixedCurrencyError only for length > 1. Also consider asserting priced.length === seatIds.length.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#mixedcurrencyerror-doubles-as-the-empty-set-error`; `packages/booking/src/booking-service.ts#empty-priced-set-reported-as-mixedcurrencyerror-with-an-empt`
- **History:**
  - 2026-10-30: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:215`, standards axis (ticket 41 review-1 standards, run 20261030-175150)
  - 2026-10-30: seen again: LOW maintainability at `packages/booking/src/booking-service.ts:215`, spec axis (ticket 41 review-1 spec, run 20261030-175150)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-030: processedAt column type in the migration does not match the Prisma schema

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/db/prisma/schema.prisma:221`
- **Problem:** The migration creates "processedAt" as TIMESTAMPTZ(3), but the model declares `DateTime @default(now())` with no `@db.Timestamptz(3)`. Prisma maps that to TIMESTAMP(3), so the schema and migration disagree.
- **Impact:** `prisma migrate diff` or `migrate dev` reports drift and generates a corrective migration that changes the column type. The schema is not the source of truth for the DB. Where Prisma writes the value (`@default(now())` is client-side for some paths), the timezone semantics are ambiguous.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the schema is not the source of truth for processed_messages.processedAt: a generated migration would silently turn TIMESTAMPTZ into TIMESTAMP. The DLQ (25) and consumer recovery with retention (27) read that table; ticket 49 fixes the drift and adds a drift check to the gate.
- **Remediation:** Add `@db.Timestamptz(3)` to `processedAt` so the schema matches the migration.
- **Target:** ticket 49 (`issues/49-prisma-schema-drift.md`)
- **Blocks:** 25, 27
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#processedat-column-type-in-the-migration-does-not-match-the-`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/db/prisma/schema.prisma:221`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: CORRECTNESS, owned by ticket 49, blocks ticket(s) 25, 27 until it is resolved (initial triage, ticket 53)

### TD-031: Relay loop swallows every tick error without any signal

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:103`
- **Problem:** `catch {}` in the background loop drops database and broker outage errors with no log or counter. `lastError` is recorded only for publish failures inside a claimed row, not when claim, update or commit fails.
- **Impact:** If the database or NATS is down, or the claim query is broken, the worker keeps looping every 250 ms while `/health` reports ok. Pending events pile up and nobody can see why.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 45; nothing is deployed, so no outage has gone unseen yet. Triage 2026-11-06: relay outages are invisible; the delayed retry schedule (24) builds on the worker loops.
- **Remediation:** Inject a logger or onError callback and report each failed tick (rate-limited). Consider a health signal for consecutive failures.
- **Target:** ticket 45 (`issues/45-worker-loop-error-reporting.md`); must merge before ticket 24, which is blocked by it
- **Blocks:** 24
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#relay-loop-swallows-every-tick-error-without-any-signal`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/messaging/src/outbox-relay.ts:103`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-04: planned for ticket 45 (`issues/45-worker-loop-error-reporting.md`), before ticket 24 (remediation planning, 2026-11-04)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 45, blocks ticket(s) 24 until it is resolved (initial triage, ticket 53)

### TD-032: Handler errors are nak'd with no trace, and the poll loop swallows all errors

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:74`
- **Problem:** When the handler or transaction throws, the runner calls `nak` and discards the error. The loop's `catch {}` at line 95 also drops fetch errors. MaxDeliver is -1, so a deterministic handler failure is redelivered forever, every 2 minutes after the 4th attempt, with the cause never recorded.
- **Impact:** A poison message loops indefinitely and is invisible. The docs admit the DLQ gate is not built, but there is not even a log of the failure.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 45 (and ticket 25 for the DLQ part). Handler failures are logged with the error and delivery count since ticket 07, but no test proves it yet and the poll loop still swallows fetch errors, so the entry stays open until ticket 45 verifies it. Triage 2026-11-06: handler and poll failures are invisible; ticket 45 owns the reporting and must resolve this entry; the endless redelivery of a poison message is ticket 25's specified DLQ gate, not part of this entry's fix.
- **Remediation:** Pass the error and delivery count to an injected error reporter before nak. Track the open DLQ gate as technical debt if it is deferred.
- **Target:** ticket 45 (`issues/45-worker-loop-error-reporting.md`) for the swallowed poll errors and the failure logging; the endless redelivery of a poison message is ticket 25's DLQ gate. Ticket 45 must merge before ticket 24, which is blocked by it
- **Blocks:** 24
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#handler-errors-are-nak-d-with-no-trace-and-the-poll-loop-swa`; `packages/booking/src/payment-saga.ts#unhandled-saga-cases-throw-into-an-invisible-unbounded-redel`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `packages/messaging/src/consumer-runner.ts:74`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-03: seen again: MEDIUM regression_risk at `packages/booking/src/payment-saga.ts:88`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-04: planned for ticket 45 (`issues/45-worker-loop-error-reporting.md`), before ticket 24; poison-message loop left to ticket 25; handler-failure logging observed in code since ticket 07 but not yet verified by a test (remediation planning, 2026-11-04)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 45, blocks ticket(s) 24 until it is resolved (initial triage, ticket 53)

### TD-033: Retention is documented but no job exists

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/db/prisma/schema.prisma:215`
- **Problem:** The model comment says rows are "Kept 14 days, longer than the 7-day stream". Nothing in the change deletes `processed_messages` rows, and docs/database does not mention retention.
- **Impact:** The table grows without bound, one row per message per consumer. A reader will assume cleanup exists.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the schema comment promises a retention job that does not exist; ticket 27 implements that job (its AC: rows older than 14 days are deleted), so it owns this entry.
- **Remediation:** Reword the comment to say retention is not implemented yet and register it as technical debt, or add the cleanup.
- **Target:** ticket 27 (`issues/27-consumer-recovery-and-outbox-republish.md`), its retention job
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#retention-is-documented-but-no-job-exists`
- **History:**
  - 2026-11-03: recorded: MEDIUM maintainability at `packages/db/prisma/schema.prisma:215`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 27, blocks no ticket (initial triage, ticket 53)

### TD-034: Startup leaks the running relay and consumers if the HTTP server fails to listen

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `apps/worker/src/worker.ts:53`
- **Problem:** The runners and relay are started (lines 40-43) before `server.listen`. A listen error (port in use) is emitted as an unhandled 'error' event and rejects nothing, so there is no cleanup path. `startWorker` also never stops the relay or runners if it throws after they start.
- **Impact:** In embedded or test use the loops keep running against closed resources after a failed start. In main.ts it is an uncaught exception with no graceful drain of in-flight claims.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 46 before deployment; the worker is not deployed, so no failed start has leaked loops in production. Triage 2026-11-06: a failed start leaks running loops; deployment (38) must wait for clean startup.
- **Remediation:** Bind the server first and reject on its 'error' event. Start the relay and runners last, or stop them in a catch.
- **Target:** ticket 46 (`issues/46-worker-startup-cleanup.md`); must merge before ticket 38 (deployment), which is blocked by it
- **Blocks:** 38
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/worker.ts#startup-leaks-the-running-relay-and-consumers-if-the-http-se`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `apps/worker/src/worker.ts:53`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-04: planned for ticket 46 (`issues/46-worker-startup-cleanup.md`), before ticket 38 (remediation planning, 2026-11-04)
  - 2026-11-06: triaged: OPERABILITY, owned by ticket 46, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-035: Shutdown has no error handling or timeout

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `apps/worker/src/main.ts:12`
- **Problem:** `shutdown` is an async signal handler with no try/catch. A rejection during `worker.stop()` or `bus.close()` becomes an unhandled rejection and skips `process.exit`, which leaves the process hung or crashing with a misleading status. There is also no bound on how long stop waits for an in-flight 60 s relay transaction.
- **Impact:** A SIGTERM during a slow tick can exceed the orchestrator's kill grace period. Failures in the shutdown path are unreported.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: shutdown error handling; the worker is not deployed and ticket 46 already owns its startup and stop path.
- **Remediation:** Wrap shutdown in try/catch and set a nonzero exit code on error. Add a deadline after which it exits.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/main.ts#shutdown-has-no-error-handling-or-timeout`
- **History:**
  - 2026-11-03: recorded: LOW defect at `apps/worker/src/main.ts:12`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-036: ensureTopology treats any `add` failure as a config mismatch

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/jetstream-message-bus.ts:112`
- **Problem:** The bare `catch {}` around `streams.add` falls through to `update` for every error, including timeouts, permission failures and invalid config. The update then surfaces a different error and the original cause is lost.
- **Impact:** Startup diagnosis is harder: the reported error describes the update, not the add failure.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a lost error cause at startup; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Catch only the JetStream 'stream name already in use' error (or look the stream up first) and rethrow anything else.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/jetstream-message-bus.ts#ensuretopology-treats-any-add-failure-as-a-config-mismatch`
- **History:**
  - 2026-11-03: recorded: LOW defect at `packages/messaging/src/jetstream-message-bus.ts:112`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-037: Reflect.get indirection kept after the export exists

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/message-bus.test.ts:36`
- **Problem:** `connectJetStreamMessageBus` is read via `Reflect.get(messaging, ...)` with a cast and a hand-written `BusHandle`/`ConnectBus` type. That was useful while the code was missing, but it now bypasses type checking of the real signature.
- **Impact:** The test compiles even if the factory's signature changes, and it adds noise.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a test-only indirection; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Import `connectJetStreamMessageBus` directly and drop the local types.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/message-bus.test.ts#reflect-get-indirection-kept-after-the-export-exists`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/message-bus.test.ts:36`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-038: A permanently unpublishable row blocks its whole aggregate

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:50`
- **Problem:** A row whose `eventType` maps to a subject outside the stream's subjects (or whose payload cannot be published) fails on every tick. `attempts` grows with no cap or terminal status, and the NOT EXISTS ordering rule then keeps every later row of that aggregate from being claimed.
- **Impact:** One bad event stalls that aggregate's events forever at 250 ms retry churn. There is no alert or dead-letter path.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: an unpublishable row stalls its aggregate, but every event type maps to a fixed subject in code, so it takes a code bug; the DLQ (25) and recovery (27) tickets cover delivery failures, and the gate will escalate it if one depends on relay liveness.
- **Remediation:** Define a maximum attempts policy (FAILED status or a DLQ route) or track the gap as technical debt.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#a-permanently-unpublishable-row-blocks-its-whole-aggregate`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/outbox-relay.ts:50`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: CORRECTNESS, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-039: The same bus and prisma setup is repeated in three test files

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.standards.json`
- **Components:** `packages/messaging/src/outbox-relay.test.ts:22`
- **Problem:** The `beforeAll`/`afterAll` that creates the prisma client and the prefixed JetStream bus is copied into outbox-relay.test.ts, consumer-runner.test.ts and worker.test.ts.
- **Impact:** A change to the isolation scheme has to be made in several places.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: duplicated test setup; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Extract a shared test helper (for example in test-infra or a messaging test-support module).
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.test.ts#the-same-bus-and-prisma-setup-is-repeated-in-three-test-file`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/outbox-relay.test.ts:22`, standards axis (ticket 06 review-3 standards, run 20261103-120228)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-040: AT-31 test does not prove the redelivery was acked as a duplicate

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** Acceptance gap: ticket 06 AC9 (AT-31) is approved, but its test proves the redelivery and the single side effect, not the duplicate ack the criterion names. A regression that naks duplicates forever would stay green, and every later consumer (first: ticket 08) relies on this path. Severity kept at MEDIUM as reported; fix before any consumer ships.
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.test.ts:221`
- **Problem:** The test asserts deliveryCounts [1,2], zero messages on the third poll, and one side effect. It never asserts that the second delivery was acked. If the P2002 to AlreadyProcessed mapping broke, the runner would nak with a 1 s delay. The third poll would still usually return 0 messages and side effects would still be 1, so the test would pass. No test pins the unique-violation-to-ack path directly.
- **Impact:** A regression that naks real duplicates forever would stay green, which is a delivery-loop failure in production.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Assert the ack directly, for example with the consumer info (num_ack_pending and num_pending both 0 after the second delivery). Alternatively, record the ack and nak calls on the wrapped message and assert that the second delivery was acked and not nak'd.
- **Target:** ticket 08 (`issues/08-mock-payment-confirms-order.md`), last AC
- **Blocks:** none
- **Acceptance:** none
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
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/outbox-relay.test.ts:86`
- **Problem:** The test compares DEFAULT_RELAY_INTERVAL_MS to 250. Nothing shows that createOutboxRelay or the worker loop uses the constant as its pacing. The batch default is covered by the 120-row test, but the interval default is not exercised.
- **Impact:** Changing the fallback in outbox-relay.ts to a literal value would not fail any test.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the relay interval default is asserted as a constant; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Assert the effective interval, for example with fake timers and a spy on bus.publish that counts ticks, or have the test pass no options and check the pacing.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.test.ts#the-250-ms-default-is-asserted-only-as-an-exported-constant`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `packages/messaging/src/outbox-relay.test.ts:86`, spec axis (ticket 06 review-3 spec, run 20261103-120228)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-042: Per-aggregate ordering (NOT EXISTS older PENDING) is not in the ticket

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 06 (`06-worker-relay-and-consumer-runner`)
- **Evidence:** `.ralph/logs/20261103-120228/06-worker-relay-and-consumer-runner.review-3.spec.json`
- **Components:** `packages/messaging/src/outbox-relay.ts:78`
- **Problem:** The claim query adds a self-referencing NOT EXISTS subquery so that only the oldest PENDING row of each aggregate is claimable. This limits throughput to one row per aggregate per tick, and no acceptance criterion asks for it. It is documented and tested, but it is an unrequested design decision that changes the 'batch of 100' semantics when rows share an aggregate.
- **Impact:** Hot aggregates drain at 4 rows per second. The cost is acceptable for the MVP, but the decision was never put to the ticket owner.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: reviewed separately: the per-aggregate ordering is intentional and documented in docs/messaging/index.md (Relay); no ADR or spec requires it and no consumer depends on it (the saga's decision matrix handles any order), so it is a design decision taken without the ticket owner, not a defect. Recommended: record it in ADR 0011 or the spec, then resolve; ACCEPTED_RISK only by a human decision.
- **Remediation:** Keep it only if an ADR or the spec requires per-aggregate order. Otherwise record it as an explicit decision in the ticket or an ADR.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/outbox-relay.ts#per-aggregate-ordering-not-exists-older-pending-is-not-in-th`
- **History:**
  - 2026-11-03: recorded: LOW scope_creep at `packages/messaging/src/outbox-relay.ts:78`, spec axis (ticket 06 review-3 spec, run 20261103-120228)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-043: placeOrder tells the replay result from the fresh result with an `"order" in placed` check

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:528`
- **Problem:** The transaction callback returns either an OrderView (idempotent duplicate, line 446) or `{ order, correlationId }` (fresh, line 526). The caller tells them apart with a structural `"order" in placed` check. The two shapes carry no explicit tag. A later field named `order` on OrderView would flip the branch silently.
- **Impact:** A duplicate request that wrongly takes the fresh branch would log a false "order placed" line. One that is misclassified the other way would return the wrapper instead of an OrderView. Only types guard against this, and that guard disappears if either shape changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a structural check tells a replayed order from a new one; ticket 16 hardens exactly that replay path, so it owns this entry.
- **Remediation:** Return a tagged result such as `{ kind: "created" | "replayed", order, correlationId }` from the transaction. Alternatively log inside a helper that only the fresh path calls.
- **Target:** ticket 16 (`issues/16-checkout-idempotency-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#placeorder-tells-the-replay-result-from-the-fresh-result-wit`; `packages/booking/src/booking-service.ts#transaction-result-discriminated-by-an-order-in-placed-check`
- **History:**
  - 2026-11-03: recorded: MEDIUM maintainability at `packages/booking/src/booking-service.ts:528`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-03: seen again: LOW maintainability at `packages/booking/src/booking-service.ts:528`, spec axis (ticket 07 review-2 spec, run 20261103-123322)
  - 2026-11-06: triaged: CORRECTNESS, owned by ticket 16, blocks no ticket (initial triage, ticket 53)

### TD-044: The message body is JSON-parsed and envelope-validated up to three times per message

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:84`
- **Problem:** `process` calls `parseJson(message.data)` and then `logBindingsFor`, which runs a full envelope safeParse, at line 60. It calls `parseJson` again at line 84, and `createEmitCausedEvent` runs `parseEnvelope` on every `emit`. The outbox relay (`logBindingsFor` on `row.payload`) repeats the pattern.
- **Impact:** Every message pays the parse and validation cost repeatedly. The logging and causation paths could also diverge if one of them changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: repeated parsing; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Parse once per message with `parseEnvelope(parseJson(data))`. Derive the log bindings and the emit cause from that single result.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#the-message-body-is-json-parsed-and-envelope-validated-up-to`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/consumer-runner.ts:84`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-045: The context-injection test is weak and can leak state

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `apps/web/src/server/logger.test.ts:27`
- **Problem:** The test asserts only `typeof ctx.logger.child === "function"`. That cannot tell an injected boundary logger from any object. It also builds a real Prisma client through `database()` and never disconnects it. `vi.unstubAllEnvs()` runs only after the assertion, so a failure leaves the stubbed env in place for later tests.
- **Impact:** A regression where the context logger stops being the boundary logger (for example the silent logger) would stay green. A failing test can pollute other tests in the file.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a weak logger-injection test; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Move `vi.unstubAllEnvs()` into `afterEach`. Assert something specific, such as `ctx.logger` being the instance `createWebLogger` built.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/logger.test.ts#the-context-injection-test-is-weak-and-can-leak-state`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/web/src/server/logger.test.ts:27`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-046: Needless `as Parameters<typeof createConsumerRunner>[0]` cast in the test

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner-logging.test.ts:63`
- **Problem:** The options object is cast to the parameter type although `logger` is a declared option and the handler fits. The recording logger also adds a `debug` method the Logger port lacks. Both look like leftovers from the red phase.
- **Impact:** The cast disables checking of the options shape and hides future signature drift in this test.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a needless cast in a test; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Remove the cast and the unused `debug` member so the compiler checks the call.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner-logging.test.ts#needless-as-parameters-typeof-createconsumerrunner-0-cast-in`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/consumer-runner-logging.test.ts:63`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-047: pino is added with a caret range while the other runtime dependencies are pinned

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `apps/web/package.json:25`
- **Problem:** `"pino": "^10.4.0"` in web and in worker. Every other runtime dependency (`next`, `zod`, `@trpc/*`, `superjson`) uses an exact version. `tsx` is the only caret, and it is a dev tool.
- **Impact:** A reinstall without the lockfile could pull a newer pino minor into production and break the reproducibility the other pins give.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the lockfile pins pino; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Pin `10.4.0` exactly in both manifests, as with the other runtime dependencies.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/package.json#pino-is-added-with-a-caret-range-while-the-other-runtime-dep`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `apps/web/package.json:25`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-048: Handler errors are logged whole with no redaction policy

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** SECURITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.standards.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:92`
- **Problem:** `log.error({ err: error, ... })` serializes the full error, message and stack. Prisma and validation errors can embed query arguments such as the buyer's contact email. The pino loggers are built with no redaction setting.
- **Impact:** Buyer contact details could end up in logs when a handler fails. No test or doc states a policy.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: handler errors may carry buyer contact details into logs with no redaction policy; nothing may be deployed (38) before ticket 51 sets one.
- **Remediation:** Add a pino `redact` configuration for contact fields in the app loggers, or log only `err.name` and a sanitized message. Document the policy under Logging and ids.
- **Target:** ticket 51 (`issues/51-log-redaction-policy.md`)
- **Blocks:** 38
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#handler-errors-are-logged-whole-with-no-redaction-policy`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.ts:92`, standards axis (ticket 07 review-2 standards, run 20261103-123322)
  - 2026-11-06: triaged: SECURITY, owned by ticket 51, blocks ticket(s) 38 until it is resolved (initial triage, ticket 53)

### TD-049: Router-to-service logger wiring is not tested

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.spec.json`
- **Components:** `apps/web/src/server/routers/booking.ts:69`
- **Problem:** bookingServiceFor now passes ctx.logger into createBookingService. Every router test injects silentLogger, so nothing proves the booking procedures actually log with the context logger. The logging test calls the service directly.
- **Impact:** Dropping `logger: ctx.logger` from bookingServiceFor would silence all booking logs in web and every test would still pass.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: router logger wiring is untested; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Add one router test that calls booking.holdSeats with a recording logger and asserts the lines carry correlationId and holdId.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/booking.ts#router-to-service-logger-wiring-is-not-tested`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/web/src/server/routers/booking.ts:69`, spec axis (ticket 07 review-2 spec, run 20261103-123322)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-050: Causation is enforced only if handlers use emit

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 07 (`07-structured-logging`)
- **Evidence:** `.ralph/logs/20261103-123322/07-structured-logging.review-2.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.ts:83`
- **Problem:** The handler still receives the raw `tx`, so a handler can write an outbox row directly and bypass emit. Only the emit path is tested; nothing detects other writes.
- **Impact:** A future consumer that writes tx.outboxEvent.create itself can emit events with wrong or missing causationId without any test failing.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: every consumer handler writes events through emit (service-store) today; no unfinished ticket relies on the affected behaviour.
- **Remediation:** State in the handler docs that emit is the only sanctioned way to write events. When the first real consumer lands, add a test of its emitted ids.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.ts#causation-is-enforced-only-if-handlers-use-emit`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.ts:83`, spec axis (ticket 07 review-2 spec, run 20261103-123322)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-051: Provider latency is awaited inside the runner's DB transaction

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** CONCURRENCY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `apps/worker/src/payment/payment-handler.ts:53`
- **Problem:** The handler runs inside the runner's interactive Prisma transaction, which already holds the processed_messages insert, and awaits clock.sleep(waitMs) there. Prisma's default interactive-transaction timeout is 5 s, and the runner sets no timeout.
- **Impact:** A configured latencyMs above a few seconds makes the transaction time out, so the message is retried forever. Even short waits hold a pooled connection while idle, which limits throughput. The default (no latency) and the test sleep stub hide this.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Planned for ticket 44, ahead of further payment work; the default latency is zero, so nothing affected runs yet. Triage 2026-11-06: provider latency inside the runner transaction can time it out and redeliver forever; the saga (17) and consumer recovery (27) build on that transaction.
- **Remediation:** Do the latency wait before the transaction (for example a handler pre-step), or document and enforce a latency bound below the transaction timeout. Add a test with a real sleep close to the timeout.
- **Target:** ticket 44 (`issues/44-payment-latency-outside-the-transaction.md`); must merge before tickets 17 and 27, which are blocked by it, so no further payment or saga work builds on the transaction behaviour
- **Blocks:** 17, 27
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment/payment-handler.ts#provider-latency-is-awaited-inside-the-runner-s-db-transacti`; `apps/worker/src/notification/notification-handler.ts#external-provider-call-awaited-inside-the-runner-s-db-transa`
- **History:**
  - 2026-11-03: recorded: MEDIUM defect at `apps/worker/src/payment/payment-handler.ts:53`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-04: planned for ticket 44 (`issues/44-payment-latency-outside-the-transaction.md`), before tickets 17 and 27 (remediation planning, 2026-11-04)
  - 2026-11-05: seen again: MEDIUM regression_risk at `apps/worker/src/notification/notification-handler.ts:77`, standards axis (ticket 09 review-3 standards, run 20261105-075349)
  - 2026-11-06: triaged: CONCURRENCY, owned by ticket 44, blocks ticket(s) 17, 27 until it is resolved (initial triage, ticket 53)

### TD-052: bookingStore and paymentStore are line-for-line copies; service names are listed in two places

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `packages/messaging/src/service-store.ts:55`
- **Problem:** The two stores differ only in the Prisma delegate and the table name. worker.ts separately hard-codes the list ["booking","payment"], and serviceStore picks via a ternary instead of a total map.
- **Impact:** A third service means editing the ServiceName union, the ternary and the worker list, with the Prisma delegate copies drifting. The compiler does not catch a service missing from the worker's list.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: copied stores; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Build the stores from a small factory over the delegate accessors. Use a Record<ServiceName, ServiceStore>, and derive the worker's relay list from Object.keys of that record or an exported constant.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/service-store.ts#bookingstore-and-paymentstore-are-line-for-line-copies-servi`; `packages/messaging/src/service-store.ts#notificationstore-is-a-third-line-for-line-copy-of-the-store`; `apps/worker/src/worker.ts#relay-service-list-still-hard-coded-separately-from-servicen`
- **History:**
  - 2026-11-03: recorded: LOW maintainability at `packages/messaging/src/service-store.ts:55`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-05: seen again: LOW maintainability at `packages/messaging/src/service-store.ts:77`, standards axis (ticket 09 review-3 standards, run 20261105-075349)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-053: Payment redelivery/poison paths are untested

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.standards.json`
- **Components:** `apps/worker/src/payment/payment-handler.test.ts:129`
- **Problem:** The tests cover only the happy path, the +dup@ double emit and the latency wait. There is no test for a redelivered order.placed under a new event id, which hits the (orderId, attemptNo) unique violation, or for an invalid payload.
- **Impact:** The behaviour of the Payment consumer on a repeated order.placed (a transaction failure that retries forever) is unspecified and unproven.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the Payment consumer's behaviour on a redelivered order.placed is unproven; the saga (17) builds on it.
- **Remediation:** Add a test pinning the intended behaviour: either an idempotent skip when an attempt already exists for the order, or an asserted failure plus the redelivery outcome.
- **Target:** ticket 50 (`issues/50-payment-flow-test-isolation-and-redelivery-coverage.md`)
- **Blocks:** 17
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment/payment-handler.test.ts#payment-redelivery-poison-paths-are-untested`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `apps/worker/src/payment/payment-handler.test.ts:129`, standards axis (ticket 08 review-2 standards, run 20261103-160343)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 50, blocks ticket(s) 17 until it is resolved (initial triage, ticket 53)

### TD-054: Consumer-info assertion may read the state before the broker has processed the ack

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/messaging/src/consumer-runner.test.ts:237`
- **Problem:** The runner's ack is fire-and-forget. The consumer info is read on a new connection straight after the last pollOnce, with no wait for the broker to apply the ack. The ack:2 outcome assertion proves the runner's decision, but num_ack_pending === 0 depends on timing.
- **Impact:** The test could flake under load on the ack-pending assertion. The ack-versus-nak guarantee itself is already proven by the outcomes assertion.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a possible flake in an assertion whose guarantee the ack outcomes already prove; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Wrap the info assertions in expect.poll, or flush the connection before reading the info.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/messaging/src/consumer-runner.test.ts#consumer-info-assertion-may-read-the-state-before-the-broker`
- **History:**
  - 2026-11-03: recorded: LOW unverified_assumption at `packages/messaging/src/consumer-runner.test.ts:237`, spec axis (ticket 08 review-2 spec, run 20261103-160343)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-055: CHECK constraint is tested by its definition text, not by its behaviour

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/db/src/payment-schema.test.ts:47`
- **Problem:** The test regex-matches pg_get_constraintdef for 'CAPTURED' and 'capturedAt'. It never inserts a CAPTURED row without capturedAt, or a non-CAPTURED row with capturedAt, to show the database rejects them.
- **Impact:** A wrong CHECK, such as one that enforces only one direction of the equivalence, would still pass.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the CHECK is asserted by its text; the payment rows that rely on it are written only by code whose tests pass; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Insert both violating rows through raw SQL or Prisma and assert each is rejected.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/src/payment-schema.test.ts#check-constraint-is-tested-by-its-definition-text-not-by-its`
- **History:**
  - 2026-11-03: recorded: LOW missing_test at `packages/db/src/payment-schema.test.ts:47`, spec axis (ticket 08 review-2 spec, run 20261103-160343)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-056: Ledger and payment schema carry columns and values beyond the ticket

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 08 (`08-mock-payment-confirms-order`)
- **Evidence:** `.ralph/logs/20261103-160343/08-mock-payment-confirms-order.review-2.spec.json`
- **Components:** `packages/db/prisma/schema.prisma:251`
- **Problem:** order_payments adds refundRequestedAt and refundAttempts. The disposition enum includes REFUND_REQUESTED, MANUAL_REVIEW and REFUNDED. payment_attempts adds ATTEMPTING and FAILED statuses with a second CHECK. None of these are used by this slice.
- **Impact:** The schema exposes unexercised states, and later tickets may want different shapes. The cost is low because the migration is still unreleased.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: reviewed separately: the columns and values match the spec's data model (docs/specs/ticketarena-mvp.md, order_payments and payment_attempts) and the refund tickets (19, 20, 23) use them; they exceed ticket 08's scope but are not harmful. Recommended: resolve as confirmed by the spec; ACCEPTED_RISK only by a human decision.
- **Remediation:** Defer the refund columns and the unused statuses to the tickets that use them, or confirm they come from the spec's data model.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/db/prisma/schema.prisma#ledger-and-payment-schema-carry-columns-and-values-beyond-th`
- **History:**
  - 2026-11-03: recorded: LOW scope_creep at `packages/db/prisma/schema.prisma:251`, spec axis (ticket 08 review-2 spec, run 20261103-160343)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-057: The sandboxed agent can write the host repository, its Git metadata and the batch state

- **Status:** RESOLVED
- **Severity:** HIGH
- **Risk:** SECURITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** harness preflight before the batch of tickets 09-11 (2026-11-04), not a slice review
- **Evidence:** `scripts/sandbox.sh:51` mounts the whole host repository read-write at `/host-repo`; the agent runs there with `--dangerously-skip-permissions` as the same user as the entrypoint (`scripts/sandbox-entrypoint.sh:38`)
- **Components:** `scripts/sandbox.sh:51`, `scripts/sandbox-entrypoint.sh:38`, `scripts/ralph-batch.mjs:204`
- **Problem:** Only convention keeps the agent in its clone. Through `/host-repo` it can write the host's `.git` (refs, hooks, config), the host working tree (including `scripts/ralph-ci.sh`, `scripts/sandbox.sh` and `ralph-loop.sh`, which the batch runs on the host between tickets) and `.ralph/batch` and `.ralph/state`. The batch accepts a merge on two marks that the agent can write itself: a `Merge slice/<slug>:` commit and an archived `done` ticket on `main`.
- **Impact:** A misbehaving agent could forge a merge that skips review and have the batch push it to GitHub. It could also run code on the host, where `gh` credentials are available, through a hook or `core.fsmonitor`, fake a CI pass by rewriting `ralph-ci.sh`, or forge batch or resume checkpoints. Autonomous production batches are blocked until this is fixed. An audit on 2026-11-04 found no evidence that any of this happened: the host `.git/config` and hooks are clean, there are no symlinks under `.ralph`, and all 15 container pushes to `main` have Ralph's merge or block shape.
- **Justification:** Found before the batch started, and no batch ran. Fixed by ticket 47, which must merge before the next production batch (user decision, 2026-11-04).
- **Remediation:** No host repository mount. Input goes in as a read-only Git bundle and output comes back as a bundle in a per-run directory. A trusted host step validates the bundle and accepts it: merge shape, ticket and dependencies, protected paths, no Git attributes, submodules or symlinks, the gate re-run in an agent-free sandbox, and strict pause validation. Batch and resume state stay host-only. Regression tests cover all four attack paths, including through real Docker.
- **Target:** ticket 47 (`issues/done/47-sandbox-trust-boundary.md`); must merge before the next production batch (tickets 09-11)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** The container mounts no part of the host repository: a read-only `/ralph-in` (Git bundle plus a copy of the resume state) and a per-run `/ralph-out`, with `--cap-drop ALL` and `no-new-privileges` (ADR 0014). `scripts/ralph-accept.mjs` imports the result bundle with the host's own Git into a quarantine namespace and moves `main` only for Ralph-shaped merges and blocked-status commits of an eligible ticket. It refuses protected harness, CI and gate paths under any spelling a case-insensitive host resolves, install scripts, host-only paths (`.ralph/`, `.env*`, `node_modules/`, anything the host ignores), Git attributes, submodules and symlinks, re-runs the gate in an agent-free sandbox, adopts only canonical pauses, and copies logs as redacted plain files. The batch keeps `.ralph/batch` host-only and stops finally on a refused result (`untrusted-result`).
- **Verification:** `scripts/ralph-accept.test.mjs` (attack paths 1-4, rejected and interrupted runs, run output types), `scripts/ralph-batch.test.mjs` (untrusted-result and checkout-changed stops), `scripts/sandbox.test.sh` (real Docker: boundary probe, merge, rejection, pause/resume, forged merge and forged pause refused)
- **Fingerprints:** `scripts/sandbox.sh#the-sandboxed-agent-can-write-the-host-repository-its-git-me`
- **History:**
  - 2026-11-04: recorded: HIGH security finding at `scripts/sandbox.sh:51`, harness preflight before the batch of tickets 09-11
  - 2026-11-04: in progress in ticket 47 (`issues/47-sandbox-trust-boundary.md`); autonomous production batches blocked until it merges (user decision, 2026-11-04)
  - 2026-11-04: resolved in ticket 47: no host repository mount; the host validates and accepts every run result itself; all four attack paths refused in unit tests and through real Docker

### TD-058: In-container review verdicts share a user with the agent

- **Status:** RESOLVED
- **Severity:** HIGH
- **Risk:** SECURITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 47 (`47-sandbox-trust-boundary`), remaining limitation of the trust boundary (2026-11-04)
- **Evidence:** `docs/adr/0014-sandbox-trust-boundary.md` (Consequences, remaining limitations)
- **Components:** `ralph-loop.sh:579`, `scripts/sandbox-entrypoint.sh:77`
- **Problem:** Inside the container, the agent runs as the same Unix user as Ralph's own gates and its two LLM reviewers. A deliberately malicious agent can leave a background process behind its session that rewrites a review report or decision file before the in-container review gate reads it. The host independently re-checks everything deterministic: the merge shape, protected paths, the full gate in an agent-free sandbox, and GitHub CI after the push. The approval of the Standards and Spec reviews, however, is not re-derived on the host.
- **Impact:** An adversarial agent could merge code that passes the tests and CI but was never approved by the reviewers. That includes code written to subvert the gate it runs in: narrowing what a package's own `vitest.config` or `tsconfig.json` covers (slices may change both), or tampering with tooling and later gate steps from its tests or its dependencies, which the agent-free re-gate and CI both execute. Merged code then runs on developer machines (the tests, `infra:up`), in GitHub CI and in the re-gate, which has network access. An accidental, non-malicious agent cannot cause this. The host repository, its Git metadata, the harness and the batch state stay out of reach during the run either way (TD-057).
- **Justification:** Recorded so it is not silently accepted. Whether it blocks autonomous production batches is the user's decision (raised 2026-11-04). Closing it means running the agent and everything that executes the slice's code under a separate user, or re-running the reviews on the host. Either is a design change beyond ticket 47.
- **Remediation:** Run the agent, and every command that executes the slice's code, as a separate unprivileged user, with no write access to the harness's review and decision files and with its processes killed after each session. Alternatively, have the host run a final, independent review round in an agent-free sandbox before it accepts a merge.
- **Target:** ticket 48 (`issues/done/48-review-and-verify-isolation.md`); must merge before the next production batch (tickets 09-11)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** The host decides both the reviews and the gate, taking nothing from the agent's container (ADR 0015). `scripts/ralph-host-review.mjs` runs its own Standards and Spec reviews of every merged slice: the host builds the changeset, a fresh token, the prompts (`scripts/ralph-review-prompt.mjs`, shared with the loop) and the schema; each reviewer is a fresh session in its own container (`sandbox-entrypoint.sh --review`) with a read-only root file system and input, tools that only read, a workspace with its write permissions removed, a single-ref bundle of exactly the candidate commit, no output mount, no host path, no Docker socket and no capabilities; the host reads the report from stdout and judges it with the review gate against the candidate's own range, files, token, criteria, register and tree. Not approved: the host blocks the ticket in its own commit and keeps the slice on `rejected/<slug>-<run>`; a provider cut-off changes nothing. `scripts/ralph-verify.mjs` replaces the single re-gate container with staged, disposable, resource-limited containers on one volume: install with network, then lint, typecheck and harness tests offline, then each package's tests offline in its own container with a read-only root file system and workspace and Yama enforced; the verdict is the exit status Docker reports. The importer fixes by the base everything that runs in a trusted role while the gate judges the slice: Vitest, Vite, PostCSS, Tailwind and Prisma configuration, `tsconfig*.json`, `.editorconfig`, `packages/test-infra/`, Prisma generators, `db:generate`, the toolchain's locked dependency closure in `pnpm-lock.yaml` (`link:` resolutions included), and a new package's gate scripts other than `test`. After the install and before any script, the image's bin check (`scripts/ralph-bins.mjs`) judges what pnpm linked: no linked bin may be named like a command on the image's PATH, no package outside the toolchain may declare a toolchain command (a fixed list in `scripts/ralph-toolchain.mjs`, so dropping a toolchain package does not free its name), nested bin directories count, every linked toolchain command must point into a toolchain package in pnpm's store (judged by the target pnpm's shim names, so whatever bin discovery the check does not model is judged by what it runs), and an unreadable dependency manifest fails (pnpm's shims would run a linked `node`).
- **Verification:** `scripts/ralph-accept.test.mjs` (host review of the exact candidate: forged in-container approvals and decisions ignored, nine forged or invalid report kinds refused, a critical finding blocks, provider cut-off changes nothing, deferred findings recorded by the host, a lost register entry refused; trusted-role files; a new package's `typecheck`, `db:generate`, `lint` and `pretypecheck` scripts; fifteen lockfile attacks, including `link:` resolutions of the test runner and tooling and a re-pointed test infrastructure), `scripts/ralph-host-review.test.mjs` (only host inputs, single-ref bundle of the candidate, fresh token per review, candidate range and files, retry and unavailable), `scripts/ralph-bins.test.mjs` (bins shadowing node, the shell, tsc, vitest and a dropped toolchain's `prisma`, by name, string and nested bin directory, from a dependency or a linked workspace package; unattributed linked bins; unreadable and byte-order-marked manifests), `scripts/sandbox.test.sh` (real Docker: `evil-bin`, a slice linking a workspace package whose nested bin directory holds `node` and `prisma`, refused before either runs; the real repository through `sandbox.sh --verify`; `evil-test`, a malicious slice whose tests try to rewrite another test, the runner and the dependencies, reach the network and the host, and fail the gate; `host-review`, a slice the agent's reviewers approve but the host's isolated reviewers block, with the reviewer container seeing exactly the candidate read-only, no output mount and no Docker socket; plus merge, rejection, pause/resume and forged merge and pause)
- **Fingerprints:** `ralph-loop.sh#in-container-review-verdicts-share-a-user-with-the-agent`
- **History:**
  - 2026-11-04: recorded: HIGH security limitation remaining after ticket 47 (trust boundary), raised for a user decision
  - 2026-11-04: independent Standards and Spec reviews of ticket 48 (host subagents, not the in-container reviewers) found two HIGH bypasses: a new package's `db:generate`/`typecheck` scripts and `link:` resolutions of toolchain packages; both fixed with tests, and the bin-shadowing vector they pointed to closed by the image's bin check; their confirmation round found two bypasses of that check (nested bin directories, a dropped toolchain package freeing `prisma`), closed by judging the linked bins and a fixed toolchain command list
  - 2026-11-04: resolved in ticket 48: the host runs its own isolated Standards and Spec reviews of the exact candidate and a hardened, staged, offline gate whose verdict is the containers' exit status; remaining limitations in ADR 0015

### TD-059: Rejected work is imported as ordinary branches

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** SECURITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 47 (`47-sandbox-trust-boundary`), Spec review round 4 (2026-11-04)
- **Evidence:** `scripts/ralph-accept.mjs` (`createBranch` for `rejected/<slug>-<run-id>`), `docs/workflow/index.md` (trust boundary, blocked-status commit)
- **Components:** `scripts/ralph-accept.mjs:926`, `scripts/ralph-batch.mjs:222`
- **Problem:** A rejected run's work is imported as `refs/heads/rejected/<slug>-<run-id>`. Its tree passed no path rule. Only a documentation note says to inspect it with `git log -p` or `git show` rather than check it out, and a broad push (`git push --all`) would publish it, so its own `.github/workflows` would run on GitHub.
- **Impact:** None while operators follow the note and push only `main`, as the batch does. A careless checkout writes untrusted files into the host working tree; a broad push runs untrusted workflows with the repository's secrets.
- **Justification:** Deferred from ticket 47: the batch (`rejectedRefs`) and `ralph-loop.sh` outside the sandbox both find rejections under `refs/heads/rejected/`, so moving them changes the batch's rejection detection and the non-sandbox loop together. The batch itself never checks out or pushes these branches. Triage 2026-11-06: rejected work lands under refs/heads/, so a broad push would run its workflows; harness-only, done in a human-reviewed commit (ticket 52) and blocks no feature ticket.
- **Remediation:** Import rejected work under `refs/ralph/rejected/<slug>-<run-id>` (outside `refs/heads`) and have the batch detect rejections there; keep `refs/heads/rejected/` only for runs outside the sandbox.
- **Target:** ticket 52 (`issues/52-harness-quarantine-and-ptrace-refusal-coverage.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-accept.mjs#rejected-work-is-imported-as-ordinary-branches`
- **History:**
  - 2026-11-04: recorded: LOW finding deferred from ticket 47's Spec review (round 4)
  - 2026-11-06: triaged: SECURITY, owned by ticket 52, blocks no ticket (initial triage, ticket 53)

### TD-060: The verifier's Yama refusal has no regression test

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 48 (`48-review-and-verify-isolation`), independent Spec review (2026-11-04)
- **Evidence:** `scripts/sandbox-entrypoint.sh` (`--test`: refuses to run unless `/proc/sys/kernel/yama/ptrace_scope` is 1-3); `scripts/sandbox.test.sh` (`evil-test` only records the host's scope)
- **Components:** `scripts/sandbox-entrypoint.sh:92`
- **Problem:** The test stage refuses to run when the kernel does not restrict `ptrace`, so a slice's test cannot trace the Vitest main process and rewrite its verdict. No test runs the stage on a kernel with scope 0, so deleting the refusal would leave every test green.
- **Impact:** None on Docker Desktop (WSL2) and GitHub's Ubuntu runners, which both run with scope 1, as `evil-test` asserts. A future host with scope 0 relies on the untested refusal.
- **Justification:** A container cannot lower the host kernel's Yama scope, and an environment override to fake it would itself be a bypass of the check. Triage 2026-11-06: the verifier's Yama refusal has no regression test; harness-only (ticket 52), blocks no feature ticket.
- **Remediation:** Read the scope from a path the entrypoint takes from its image build (a test image overrides it with a file holding 0), and add a Docker scenario that expects the refusal.
- **Target:** ticket 52 (`issues/52-harness-quarantine-and-ptrace-refusal-coverage.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/sandbox-entrypoint.sh#the-verifiers-yama-refusal-has-no-regression-test`
- **History:**
  - 2026-11-04: recorded: LOW finding deferred from ticket 48's independent Spec review
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 52, blocks no ticket (initial triage, ticket 53)

### TD-061: The verifier's prepare stage hard-codes the workspace groups

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 48 (`48-review-and-verify-isolation`), independent Standards review (2026-11-04)
- **Evidence:** `scripts/sandbox-entrypoint.sh` (`--prepare` creates `.vite-temp` and `.vitest-cache` under `apps/*` and `packages/*`); `scripts/ralph-verify.mjs` (`testTargets` reads the groups from `pnpm-workspace.yaml`)
- **Components:** `scripts/sandbox-entrypoint.sh:77`
- **Problem:** The workspace groups are known in two places. A group added to `pnpm-workspace.yaml` (a protected file) gets test containers but no cache directories.
- **Impact:** Fails closed: that group's test containers cannot mount their tmpfs on the read-only volume and the gate fails, with a confusing message.
- **Justification:** Only a human-reviewed commit can add a workspace group, and it would see the failure at once. Triage 2026-11-06: fails closed and only a human-reviewed commit can add a workspace group; harness only.
- **Remediation:** Pass the test targets from `ralph-verify.mjs` to the prepare stage, or derive both from one reader of `pnpm-workspace.yaml`.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/sandbox-entrypoint.sh#the-verifiers-prepare-stage-hard-codes-the-workspace-groups`
- **History:**
  - 2026-11-04: recorded: LOW finding deferred from ticket 48's independent Standards review
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-062: Resume test does not redeliver the same message and hides errors

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 09 (`09-confirmation-notification`)
- **Evidence:** `.ralph/logs/20261105-075349/09-confirmation-notification.review-3.standards.json`
- **Components:** `apps/worker/src/notification/notification-handler.test.ts:137`
- **Problem:** The second `deliver` call uses a new subject, consumer and msgId, so it is a fresh message rather than a redelivery of the failed one. `.catch(() => undefined)` is dead code because `pollOnce` nak's and never throws. It would also hide a real setup error.
- **Impact:** The test proves resume-by-unique-key but not nak, redelivery or the partial-failure case, where one channel is sent and the next fails. That case is the at-least-once behaviour the ticket documents.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: no test redelivers a failed notification or covers a partial send; refund notifications (21) rely on that redelivery.
- **Remediation:** Drop the catch. Add a case where the SMS send fails after the EMAIL send, then redeliver and assert both end SENT with the same keys and no duplicate deliveries.
- **Target:** ticket 50 (`issues/50-payment-flow-test-isolation-and-redelivery-coverage.md`)
- **Blocks:** 21
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/notification/notification-handler.test.ts#resume-test-does-not-redeliver-the-same-message-and-hides-er`
- **History:**
  - 2026-11-05: recorded: LOW missing_test at `apps/worker/src/notification/notification-handler.test.ts:137`, standards axis (ticket 09 review-3 standards, run 20261105-075349)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 50, blocks ticket(s) 21 until it is resolved (initial triage, ticket 53)

### TD-063: Test asserts a literal markdown string

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 09 (`09-confirmation-notification`)
- **Evidence:** `.ralph/logs/20261105-075349/09-confirmation-notification.review-3.standards.json`
- **Components:** `apps/worker/src/notification/delivery-docs.test.ts:12`
- **Problem:** The test passes if the docs contain the bold phrase and fails on any rewording. It checks neither provider nor handler behaviour. The path `../../../../docs` also couples it to the repo layout.
- **Impact:** The test breaks on harmless edits to the docs and proves nothing about delivery.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a brittle docs test; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Drop the test, since the docs are reviewed, or keep it only if the ticket explicitly demands an enforced doc.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/notification/delivery-docs.test.ts#test-asserts-a-literal-markdown-string`
- **History:**
  - 2026-11-05: recorded: LOW maintainability at `apps/worker/src/notification/delivery-docs.test.ts:12`, standards axis (ticket 09 review-3 standards, run 20261105-075349)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-064: Channel union duplicates the Prisma NotificationChannel enum

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 09 (`09-confirmation-notification`)
- **Evidence:** `.ralph/logs/20261105-075349/09-confirmation-notification.review-3.standards.json`
- **Components:** `apps/worker/src/notification/mock-provider.ts:1`
- **Problem:** `NotificationChannel = "EMAIL" | "SMS"` is declared by hand next to the generated Prisma enum of the same name and values.
- **Impact:** Adding a channel needs edits in the schema, the migration and this union. The compiler only partly links them, since the handler passes the string into Prisma.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a duplicated union; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Derive the type from the Prisma enum, or document why the provider boundary stays decoupled from the db package.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/notification/mock-provider.ts#channel-union-duplicates-the-prisma-notificationchannel-enum`
- **History:**
  - 2026-11-05: recorded: LOW maintainability at `apps/worker/src/notification/mock-provider.ts:1`, standards axis (ticket 09 review-3 standards, run 20261105-075349)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-065: +dup@ end-to-end test does not prove nothing extra arrives later

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 09 (`09-confirmation-notification`)
- **Evidence:** `.ralph/logs/20261105-075349/09-confirmation-notification.review-3.spec.json`
- **Components:** `apps/worker/src/payment-flow.test.ts:172`
- **Problem:** The test polls until provider.deliveries() is 2, then reads records through findFirstOrThrow on a single order.confirmed outbox row. A second order.confirmed or a late duplicate notification would not be caught if it arrived after the poll returned. It never asserts that only one order.confirmed event exists, and never asserts a stable count of notification rows.
- **Impact:** A regression that emitted two order.confirmed events for the duplicated payment.succeeded, or that created extra records, could pass. Today the saga ignores the duplicate through the known_payment check, so the real risk is low.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the +dup@ test does not prove that nothing extra arrives later; refund notifications (21) rely on exactly-once confirmation records.
- **Remediation:** Assert that exactly one order.confirmed outbox row exists for the order. Assert notification.count is 2 after the relay has had a short settle period, for example by polling until the outbox is PUBLISHED.
- **Target:** ticket 50 (`issues/50-payment-flow-test-isolation-and-redelivery-coverage.md`)
- **Blocks:** 21
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment-flow.test.ts#dup-end-to-end-test-does-not-prove-nothing-extra-arrives-lat`
- **History:**
  - 2026-11-05: recorded: LOW missing_test at `apps/worker/src/payment-flow.test.ts:172`, spec axis (ticket 09 review-3 spec, run 20261105-075349)
  - 2026-11-05: still open, not made worse: branch `fix/flaky-tests-and-race-lost-metric` replaced the delivery-count poll with a bounded poll of this order's persisted states and keyed deliveries (`confirmationOf`), fixing the CI flake on main a81412f (EMAIL read as PENDING); a late extra record or a second order.confirmed is still not asserted. Cross-test leakage it works around is TD-072
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 50, blocks ticket(s) 21 until it is resolved (initial triage, ticket 53)

### TD-066: race_lost is counted for any SeatUnavailableError from the locked step, not only real races

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/logs/20261105-143619/10-hot-seat-race-and-fast-path.review-3.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:488`
- **Problem:** The snapshot treats a HELD seat with an expired hold as holdable. The locked step still refuses every seat whose status is not AVAILABLE (booking-service.ts:429-433), which is the lazy-expiry gap in TD-013. It also refuses seats that are not in the event. Both cases pass the snapshot and then throw SeatUnavailableError inside the transaction, so the catch counts them as race_lost although no other buyer won a race.
- **Impact:** The race_lost counter, which is documented as 'a prevented double booking', over-counts. Every attempt on an expired-but-unswept hold is recorded as a lost race, which skews contention monitoring.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Count race_lost only when the refusal cannot be explained by the snapshot, for example by checking that the refused seats were AVAILABLE or unexpired-free in the snapshot. Otherwise count seat_unavailable for the other cases, or fix lazy expiry (TD-013) and add a test with an expired HELD seat that asserts the counter.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** The lock-free snapshot now records each requested seat's status and hold, the locked read selects the same, and `lostRace` counts `race_lost` only when a refused seat changed between the two reads. A refused seat that is unchanged (an expired but unswept hold, TD-013) or unknown to the event counts `seat_unavailable`. The spec (holdSeats step 5) and `docs/database/index.md` say the same.
- **Verification:** `packages/booking/src/hold-fast-path.test.ts::an expired HELD seat refused under the lock counts seat_unavailable, not race_lost`; `packages/booking/src/hold-fast-path.test.ts::an unknown seat id counts seat_unavailable, not race_lost`; `packages/booking/src/hold-fast-path.test.ts::a seat taken between snapshot and lock counts race_lost only`
- **Fingerprints:** `packages/booking/src/booking-service.ts#race-lost-is-counted-for-any-seatunavailableerror-from-the-l`
- **History:**
  - 2026-11-05: recorded: MEDIUM defect at `packages/booking/src/booking-service.ts:488`, standards axis (ticket 10 review-3 standards, run 20261105-143619)
  - 2026-11-05: seen again: MEDIUM defect at `packages/booking/src/booking-service.ts:488`, spec axis (ticket 10 host review spec, run 20261105-153541-378)
  - 2026-11-05: resolved on branch `fix/flaky-tests-and-race-lost-metric` (human commit after batch #3): both regression tests failed before the fix (counted race_lost) and pass after; `hold-fast-path.test.ts` passed 40/40 repeated runs, `hold-race.test.ts` 10/10
  - 2026-11-05: resolution verified: independent host-side Standards and Spec review of `fix/flaky-tests-and-race-lost-metric` approved in its third round with no remaining findings, and `pnpm run check` passed on the branch

### TD-067: Saturation detection matches a pg-pool error message string, and P2028 also covers non-saturation timeouts

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-06: user decision to split ticket 12 after two rejected runs; owner moved to ticket 54
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/logs/20261105-143619/10-hot-seat-race-and-fast-path.review-3.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:286`
- **Problem:** isSaturation matches the substring 'timeout exceeded when trying to connect' in error.message. This couples the code to pg-pool wording. P2028 is also raised when an interactive transaction exceeds its own runtime timeout, or when it is already closed, so a slow transaction can be reported as BOOKING_BUSY ('retryable').
- **Impact:** A pg-pool upgrade that rewords the message silently turns saturation into a generic 500. A P2028 raised at commit time is ambiguous, so a client retry could repeat a hold that actually committed. The retry would then get SEAT_UNAVAILABLE, which is confusing but not unsafe.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a P2028 raised for a transaction's own timeout is reported as a retryable BOOKING_BUSY, and saturation is detected by a pg-pool message string; ticket 12 (now ticket 54) defines BOOKING_BUSY and its retry, so it owns this.
- **Remediation:** Pin the message in a test against the real driver (hold-busy.test.ts partly does this) and note the coupling next to the constant. Consider limiting P2028 to the start-wait case if the error meta allows.
- **Target:** ticket 54 (`issues/54-transaction-timeouts-and-retries.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#saturation-detection-matches-a-pg-pool-error-message-string-`
- **History:**
  - 2026-11-05: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:286`, standards axis (ticket 10 review-3 standards, run 20261105-143619)
  - 2026-11-06: triaged: CORRECTNESS, owned by ticket 12, blocks no ticket (initial triage, ticket 53)
  - 2026-11-06: re-planned for ticket 54 (`issues/54-transaction-timeouts-and-retries.md`): ticket 12 was split into tickets 54-57 after rejected runs 20261106-132615 and 20261106-165157 (user decision, 2026-11-06)

### TD-068: SOLD/IN_CHECKOUT test re-implements settleWithin inline

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/logs/20261105-143619/10-hot-seat-race-and-fast-path.review-3.standards.json`
- **Components:** `packages/booking/src/hold-fast-path.test.ts:108`
- **Problem:** The test.each body repeats the Promise.race with a timeout that the settleWithin helper (line 28) already provides, and the other tests use the helper.
- **Impact:** The 'blocked' budget logic exists in two places and can drift.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: duplicated test logic; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Call settleWithin(service.holdSeats(bob, event.id, [seat.id])) here, as the other tests do.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/hold-fast-path.test.ts#sold-in-checkout-test-re-implements-settlewithin-inline`
- **History:**
  - 2026-11-05: recorded: LOW maintainability at `packages/booking/src/hold-fast-path.test.ts:108`, standards axis (ticket 10 review-3 standards, run 20261105-143619)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-069: race_lost test can flake: release races the snapshot read

- **Status:** RESOLVED
- **Severity:** MEDIUM
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/logs/20261105-143619/10-hot-seat-race-and-fast-path.review-3.spec.json`
- **Components:** `packages/booking/src/hold-fast-path.test.ts:201`
- **Problem:** The test starts holdSeats and calls lock.release() immediately. Nothing proves the snapshot has run while the seat was still visibly AVAILABLE. If the other transaction's UPDATE and COMMIT reach Postgres before the snapshot query, the snapshot sees SOLD and counts seat_unavailable, so the assertion calls toEqual(['race_lost']) fails.
- **Impact:** Intermittent failures on a slow or loaded CI machine, or a pass that no longer exercises the race path. AC4's race_lost counting then rests on timing luck.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Release only once the hold is provably blocked on the lock. For example, poll pg_locks or pg_stat_activity for a waiting backend on the seat row, or wait until the snapshot has resolved, before calling release().
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** The locking transaction reports its `pg_backend_pid()`, and the test releases the lock only after `pg_stat_activity` shows a backend blocked by it (`pg_blocking_pids`). holdSeats reads its snapshot before opening the locking transaction, so the snapshot provably saw the seat AVAILABLE before it became SOLD, with no timing assumption. The poll is bounded (10 s).
- **Verification:** `packages/booking/src/hold-fast-path.test.ts::a seat taken between snapshot and lock counts race_lost only`
- **Fingerprints:** `packages/booking/src/hold-fast-path.test.ts#race-lost-test-can-flake-release-races-the-snapshot-read`; `packages/booking/src/hold-fast-path.test.ts#race-lost-test-does-not-prove-the-hold-was-blocked-on-the-lo`
- **History:**
  - 2026-11-05: recorded: MEDIUM missing_test at `packages/booking/src/hold-fast-path.test.ts:201`, spec axis (ticket 10 review-3 spec, run 20261105-143619)
  - 2026-11-05: seen again: MEDIUM missing_test at `packages/booking/src/hold-fast-path.test.ts:201`, spec axis (ticket 10 host review spec, run 20261105-153541-378)
  - 2026-11-05: resolved on branch `fix/flaky-tests-and-race-lost-metric` (human commit after batch #3): the release now waits for a backend blocked by the lock (`pg_blocking_pids`); `hold-fast-path.test.ts` passed 40/40 repeated runs, run alongside the worker suite for load
  - 2026-11-05: resolution verified: independent host-side Standards and Spec review of `fix/flaky-tests-and-race-lost-metric` approved in its third round with no remaining findings, and `pnpm run check` passed on the branch

### TD-070: Metrics adapter is never wired in production code

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/logs/20261105-143619/10-hot-seat-race-and-fast-path.review-3.spec.json`
- **Components:** `docs/index.md:67`
- **Problem:** bookingServiceFor in apps/web/src/server/routers/booking.ts:70-76 builds the service without `metrics`, and no other non-test caller uses createRedisBookingMetrics. In the app, hold_ok, seat_unavailable and race_lost are therefore never counted. The docs state that counters go to Redis.
- **Impact:** The docs overstate current behaviour. The counters exist only in tests until a later ticket wires a Redis client into the app. The ACs only require the port and the adapter, so this is not an AC failure.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: the docs overstate where counters go; the admin snapshot (35) reports 'the metrics available so far', so it does not rely on them being wired.
- **Remediation:** Either soften the docs sentence to say the adapter exists but is not yet wired, or name the ticket that wires it in.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `docs/index.md#metrics-adapter-is-never-wired-in-production-code`; `docs/index.md#docs-say-counters-go-to-redis-but-the-metrics-adapter-is-not`; `apps/web/src/server/trpc.ts#ctx-metrics-is-added-but-no-production-router-consumes-it`
- **History:**
  - 2026-11-05: recorded: LOW spec_gap at `docs/index.md:67`, spec axis (ticket 10 review-3 spec, run 20261105-143619)
  - 2026-11-05: seen again: LOW spec_gap at `docs/index.md:67`, spec axis (ticket 10 host review spec, run 20261105-153541-378)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)
  - 2026-11-08: seen again: LOW regression_risk at `apps/web/src/server/trpc.ts:27`, standards axis (ticket 56 host review standards, run replay-20261108122117-29384)

### TD-071: Saturation tests assume the occupier holds the only connection after a fixed 50 ms sleep

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: user decision to split ticket 12 after two rejected runs; owner moved to ticket 55
- **Escalation:** none
- **Source:** ticket 10 (`10-hot-seat-race-and-fast-path`)
- **Evidence:** `.ralph/host-review/20261105-153541-378/10-hot-seat-race-and-fast-path.standards.json`
- **Components:** `packages/booking/src/hold-busy.test.ts:70`
- **Problem:** Both saturation tests start an occupying transaction and then sleep 50 ms, assuming it has taken the pool's only connection. Nothing signals that the occupier's SELECT 1 has run. The same pattern is in apps/web/src/server/routers/booking.test.ts at lines 207-211.
- **Impact:** On a slow or loaded CI machine a holdSeats call can get the connection before the occupier does. The call then succeeds or fails differently, and the BOOKING_BUSY assertion fails intermittently.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the host's own review approved the ticket. Escalate if its real impact grows. Triage 2026-11-06: the saturation tests rely on a 50 ms sleep to occupy the pool; ticket 12 (now ticket 55) extends exactly these BOOKING_BUSY tests, so it owns this.
- **Remediation:** Resolve a promise from inside the occupier transaction after SELECT 1 and await it, as lockSeatElsewhere does with lockTaken, instead of sleeping.
- **Target:** ticket 55 (`issues/55-deterministic-transaction-tests.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** Both saturation tests occupy the pool with `occupy` from `@ticketarena/booking/testing`, which resolves only after a query has run inside the occupying transaction, so neither saturation test sleeps to order the occupier any more. The recorded cause was only half of it: the observed failures were the occupier's own transaction failing to start on a cold pool (`P2028` in booking, `Connection terminated due to connection timeout` in web) under the test's short budgets, so `occupy` also retries a failure before its signal until an explicit deadline. Production code is unchanged.
- **Verification:** `packages/booking/src/testing/occupy.test.ts::resolves only when Postgres shows its backend inside an open transaction`; `packages/booking/src/testing/occupy.test.ts::starts again after an attempt fails before its signal`; `packages/booking/src/testing/occupy.test.ts::fails at its deadline, naming what it waited for`; `packages/booking/src/hold-busy.test.ts::holds wait for an occupier that is slow to start`; `apps/web/src/server/routers/booking.test.ts::the request waits for an occupier that is slow to start`
- **Fingerprints:** `packages/booking/src/hold-busy.test.ts#saturation-tests-assume-the-occupier-holds-the-only-connecti`
- **History:**
  - 2026-11-05: recorded: LOW missing_test at `packages/booking/src/hold-busy.test.ts:70`, standards axis (ticket 10 host review standards, run 20261105-153541-378)
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 12, blocks no ticket (initial triage, ticket 53)
  - 2026-11-06: re-planned for ticket 55 (`issues/55-deterministic-transaction-tests.md`): ticket 12 was split into tickets 54-57 after rejected runs 20261106-132615 and 20261106-165157 (user decision, 2026-11-06)
  - 2026-11-10: resolved on branch `fix/td-071-deterministic-saturation` (maintainer decision to fix before merging the harness branches, ahead of ticket 55): `occupy` replaces the 50 ms sleep; making it resolve before its query turns the delayed-occupier tests red (mutation check)
  - 2026-11-13: resolution verified: quality gate green and independent review approved on the combined tree of the harness branches (`TM-integration` at 4461c41; reviews in `.ralph/reviews/20261110-harness-branches/`, review findings fixed in 0e2b12c; maintainer accepted the combined verification results, 2026-11-13)

### TD-072: payment-flow tests share one durable consumer, so a test can receive an earlier test's unacked event

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** fix branch `fix/flaky-tests-and-race-lost-metric` (after batch #3)
- **Evidence:** a repeated local run of `apps/worker/src/payment-flow.test.ts` (19/20) saw 3 provider deliveries in the `+dup@` test instead of 2; independent Standards and Spec review of that branch, 2026-11-05
- **Components:** `apps/worker/src/payment-flow.test.ts:56`
- **Problem:** All tests in the file start a worker on the same NATS stream prefix with the same durable `notification` consumer. A test that stops its worker once its order is CONFIRMED (the `+dup@` state test) can leave its `order.confirmed` unacked; the next test's worker then receives and sends it. The AT-15 assertions now scope deliveries to the order's own notification ids (`confirmationOf`), which removes the flake but hides the leak.
- **Impact:** Cross-test leakage makes exact-count assertions on shared state unreliable, and a test can no longer see a redelivery that reached the provider again after an earlier, uncommitted send.
- **Justification:** Test isolation only; production consumers are per deployment and idempotent per `(sourceEventId, channel)`. The scoped assertions keep AT-14/AT-15 exact for each order. Triage 2026-11-06: payment-flow tests share one durable consumer, so a test can see another's event; the saga (17) extends these tests.
- **Remediation:** Give each test its own consumer (or stream prefix), or have each test wait until the notification consumer has no pending or unacked messages before `worker.stop()`.
- **Target:** ticket 50 (`issues/50-payment-flow-test-isolation-and-redelivery-coverage.md`)
- **Blocks:** 17
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/worker/src/payment-flow.test.ts#payment-flow-tests-share-one-durable-consumer`
- **History:**
  - 2026-11-05: recorded: LOW test_isolation at `apps/worker/src/payment-flow.test.ts:56`, found while deflaking AT-15 (repeated runs) and confirmed by the branch's Standards and Spec review
  - 2026-11-06: triaged: VERIFICATION, owned by ticket 50, blocks ticket(s) 17 until it is resolved (initial triage, ticket 53)

### TD-073: One constant serves as both the per-hold cap and the per-buyer limit

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/logs/20261106-073411/11-multi-seat-holds-and-buyer-limit.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:196`
- **Problem:** MAX_SEATS_PER_BUYER is also used as the maximum seats in one hold (holdOnce validation at line 508, zod max in the router). Both are 6 today, but they are distinct rules: seats per request and seats per buyer and event. The comment says only 'per buyer and event'. hold-seat-count.test.ts then defines its own MAX_SEATS_PER_HOLD = 6.
- **Impact:** If one limit changes, the other silently changes or the tests drift, and the test constant is a second copy of the value.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: both limits are 6 today; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Either document that the per-hold cap deliberately equals the buyer limit, or add a separate MAX_SEATS_PER_HOLD. Have the tests import the exported constant.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#one-constant-serves-as-both-the-per-hold-cap-and-the-per-buy`
- **History:**
  - 2026-11-06: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:196`, standards axis (ticket 11 review-2 standards, run 20261106-073411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-074: Internal LimitExceeded mirrors the public LimitExceededError

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/logs/20261106-073411/11-multi-seat-holds-and-buyer-limit.review-2.standards.json`
- **Components:** `packages/booking/src/booking-service.ts:410`
- **Problem:** A private LimitExceeded class (used, requested) is thrown inside the transaction, and the catch immediately re-wraps it into LimitExceededError with the same fields. LockedRefusal does the same for SeatUnavailableError, so the pattern is consistent, but the public error could be thrown directly because the metric is the only extra step.
- **Impact:** Two parallel classes and one more catch branch for no behavioural gain.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a parallel error class; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Throw LimitExceededError inside the transaction and count the metric in the catch by instanceof, or leave as is for consistency with LockedRefusal.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/booking-service.ts#internal-limitexceeded-mirrors-the-public-limitexceedederror`
- **History:**
  - 2026-11-06: recorded: LOW maintainability at `packages/booking/src/booking-service.ts:410`, standards axis (ticket 11 review-2 standards, run 20261106-073411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-075: Lock-order tests rely on a fixed 400 ms sleep to show 'pending'

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/logs/20261106-073411/11-multi-seat-holds-and-buyer-limit.review-2.standards.json`
- **Components:** `packages/booking/src/hold-buyer-limit.test.ts:202`
- **Problem:** The tests assert that holdSeats and placeOrder are still pending after sleep(400) while a foreign transaction holds the advisory lock. A call that is merely slow also passes, so the 'waits on the lock' claim is shown by elapsed time only. The same sleep-based pattern is already tracked for other tests.
- **Impact:** If the lock were dropped, the first test would still fail through the NOWAIT probe, but the placeOrder test would pass vacuously on a slow machine. That test has no seat-level check.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows.
- **Remediation:** Confirm the wait through pg_stat_activity / pg_blocking_pids on the advisory lock, as hold-fast-path.test.ts does, instead of a fixed sleep. Alternatively assert that the placeOrder order row does not exist before release.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** The sleep is gone. The lock holder records its `pg_backend_pid()`, and the tests poll `pg_locks` until the expected number of backends wait, not granted, on an advisory lock blocked by that pid (`pg_blocking_pids`); a request that skipped the buyer lock never appears there and the poll fails. The placeOrder test also locks the hold row and its seat `NOWAIT` while the order waits.
- **Verification:** `packages/booking/src/hold-buyer-limit.test.ts::holdSeats waits on the buyer lock before touching any seat row`; `packages/booking/src/hold-buyer-limit.test.ts::placeOrder waits on the buyer lock before locking the hold or its seats`
- **Fingerprints:** `packages/booking/src/hold-buyer-limit.test.ts#lock-order-tests-rely-on-a-fixed-400-ms-sleep-to-show-pendin`
- **History:**
  - 2026-11-06: recorded: LOW missing_test at `packages/booking/src/hold-buyer-limit.test.ts:202`, standards axis (ticket 11 review-2 standards, run 20261106-073411)
  - 2026-11-06: resolved on branch `fix/buyer-lock-order-tests` (human commit after ticket 11): both tests fail when the service skips the buyer lock (mutation checks)
  - 2026-11-06: resolution verified: quality gate green and independent review approved (fix/buyer-lock-order-tests confirmation review, run a2ba22b)

### TD-076: buyer(), freeSeats(), service() and DB setup are copied across new test files

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/logs/20261106-073411/11-multi-seat-holds-and-buyer-limit.review-2.standards.json`
- **Components:** `packages/booking/src/hold-seat-count.test.ts:18`; `packages/booking/src/hold-buyer-limit.test.ts:179`
- **Problem:** hold-seat-count.test.ts and hold-buyer-limit.test.ts repeat the same db(), buyer(n), freeSeats() and service() helpers, plus the beforeAll/afterAll scaffolding (lines 7-43 here, 7-42 there).
- **Impact:** Fixture drift between the files, and more places to edit when the setup changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: duplicated test helpers; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Move the shared helpers into a test support module in packages/booking/src.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/hold-seat-count.test.ts#buyer-freeseats-service-and-db-setup-are-copied-across-new-t`
- **History:**
  - 2026-11-06: recorded: LOW maintainability at `packages/booking/src/hold-seat-count.test.ts:18`, standards axis (ticket 11 review-2 standards, run 20261106-073411)
  - 2026-11-06: seen again: the lock-holder helper `holdBuyerLock` in `hold-buyer-limit.test.ts` repeats the locker-pid pattern of `lockSeatElsewhere` in `hold-fast-path.test.ts`, with its own wait query (independent Standards review of `fix/buyer-lock-order-tests`)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-077: Index summary omits the new limit_exceeded counter

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/logs/20261106-073411/11-multi-seat-holds-and-buyer-limit.review-2.standards.json`
- **Components:** `docs/index.md:67`
- **Problem:** The summary now describes the buyer limit but still lists the per-event counters as 'hold_ok/seat_unavailable/race_lost'. docs/database/index.md lists limit_exceeded.
- **Impact:** A small inconsistency between the two docs.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the ticket merged. Escalate if its real impact grows. Triage 2026-11-06: a docs inconsistency; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Add limit_exceeded to the counter list in docs/index.md.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `docs/index.md#index-summary-omits-the-new-limit-exceeded-counter`
- **History:**
  - 2026-11-06: recorded: LOW maintainability at `docs/index.md:67`, standards axis (ticket 11 review-2 standards, run 20261106-073411)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-078: LIMIT_EXCEEDED to CONFLICT mapping has no router test

- **Status:** RESOLVED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 11 (`11-multi-seat-holds-and-buyer-limit`)
- **Evidence:** `.ralph/host-review/20261106-083344-25819/11-multi-seat-holds-and-buyer-limit.standards.json`
- **Components:** `apps/web/src/server/routers/booking.ts:89`
- **Problem:** The router now maps LimitExceededError to CONFLICT alongside SeatUnavailableError. The new router tests cover the seat-count bounds and a foreign-event CONFLICT, but none drives a buyer over the limit through tRPC.
- **Impact:** If the instanceof branch were dropped or reordered, the limit would surface as INTERNAL_SERVER_ERROR and only the router layer would break. Service tests would still pass.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the host's own review approved the ticket. Escalate if its real impact grows.
- **Remediation:** Add a booking.test.ts case that holds 4 seats, then requests 3 more and expects code CONFLICT.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** A router test holds six seats through tRPC, then asks for a seventh as the same guest: the answer is CONFLICT naming LIMIT_EXCEEDED, the seventh seat stays AVAILABLE with no hold or claim, and the buyer still has exactly one hold.
- **Verification:** `apps/web/src/server/routers/booking.test.ts::a hold past the six-seat buyer limit is CONFLICT naming LIMIT_EXCEEDED and holds nothing`
- **Fingerprints:** `apps/web/src/server/routers/booking.ts#limit-exceeded-to-conflict-mapping-has-no-router-test`; `apps/web/src/server/routers/booking.ts#router-mapping-of-limitexceedederror-to-conflict-is-untested`
- **History:**
  - 2026-11-06: recorded: LOW missing_test at `apps/web/src/server/routers/booking.ts:89`, standards axis (ticket 11 host review standards, run 20261106-083344-25819)
  - 2026-11-06: seen again: LOW missing_test at `apps/web/src/server/routers/booking.ts:89`, spec axis (ticket 11 host review spec, run 20261106-083344-25819)
  - 2026-11-06: resolved on branch `fix/buyer-lock-order-tests` (human commit after ticket 11): the test fails when the router stops mapping LimitExceededError (mutation check)
  - 2026-11-06: resolution verified: quality gate green and independent review approved (fix/buyer-lock-order-tests confirmation review, run a2ba22b)

### TD-079: Race cases assume the queuedFirst request runs first without asserting it

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** remediation after ticket 11 (`fix/buyer-lock-order-tests`)
- **Evidence:** `.ralph/reviews/fix-buyer-lock-order-tests/review-2.standards.json`
- **Components:** `packages/booking/src/hold-buyer-limit.test.ts:277`
- **Problem:** Each test.each case of the TD-026 race fixes which request queues first on the buyer advisory lock and relies on Postgres granting waiters of one lock in arrival order. That is how the lock manager works, but it is not a documented guarantee, and the test never checks which request actually committed first.
- **Impact:** If that behaviour changed, 'both orders run' would silently collapse to one order; the test still passes because the outcome is the same either way.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when both independent reviewers approved the remediation. Escalate if its real impact grows. Triage 2026-11-06: reviewed separately: the race test relies on Postgres granting one lock's waiters in arrival order, which the lock manager does but does not document; both orders give the same outcome, so a change there weakens the test, not the guarantee it checks. Kept deferred and documented; escalate if the outcome ever depends on the order.
- **Remediation:** Record the commit order (for example by comparing database-clock timestamps of the order row and the second hold row) and assert it matches queuedFirst, or accept the documented reasoning in the test comment.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/hold-buyer-limit.test.ts#race-cases-assume-the-queuedfirst-request-runs-first-without`
- **History:**
  - 2026-11-06: recorded: LOW missing_test at `packages/booking/src/hold-buyer-limit.test.ts:277`, standards axis (fix/buyer-lock-order-tests confirmation review standards, run a2ba22b)
  - 2026-11-06: triaged: VERIFICATION, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-080: Race test titles read 'a hold of 1 seats'

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** MAINTAINABILITY
- **Triage:** 2026-11-06: initial triage when the debt gate was introduced (ticket 53, harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** remediation after ticket 11 (`fix/buyer-lock-order-tests`)
- **Evidence:** `.ralph/reviews/fix-buyer-lock-order-tests/review-2.spec.json`
- **Components:** `packages/booking/src/hold-buyer-limit.test.ts:283`
- **Problem:** The test.each title template renders 'a hold of 1 seats' for the one-seat cases.
- **Impact:** Cosmetic only. A rename must also update TD-026's Verification names, which quote the titles.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when both independent reviewers approved the remediation. Escalate if its real impact grows. Triage 2026-11-06: cosmetic test titles; no unfinished ticket relies on the affected behaviour.
- **Remediation:** Reword the template so it reads naturally for one seat, and update TD-026's Verification in the same commit.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `packages/booking/src/hold-buyer-limit.test.ts#race-test-titles-read-a-hold-of-1-seats`
- **History:**
  - 2026-11-06: recorded: LOW style at `packages/booking/src/hold-buyer-limit.test.ts:283`, spec axis (fix/buyer-lock-order-tests confirmation review spec, run a2ba22b)
  - 2026-11-06: triaged: MAINTAINABILITY, no owner: deferred, blocks no ticket (initial triage, ticket 53)

### TD-081: A resumed ticket that debt now blocks ends the batch instead of pausing it

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: triaged by the maintainer of ticket 53 with the confirmation review (harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 53 (`harness/53-risk-based-debt-gate`)
- **Evidence:** host-side confirmation review (Spec axis) of `4d0a7cb`, recorded in `issues/done/53-risk-based-debt-gate.md`
- **Components:** `scripts/ralph-batch.mjs:267`
- **Problem:** When a paused ticket is resumed and the debt gate now says `waiting`, the batch stops `unresolved-dependency` (exit 2) and is marked finished; the paused entry stays `running` and the remaining `--max-tickets` budget is dropped.
- **Impact:** Safe (nothing runs), but the operator loses the resume semantics: a rerun without `--max-tickets` errors and a new batch must be started.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when both independent host-side reviewers approved ticket 53's confirmation round. Triage 2026-11-06: fails safe (it can only hold work, never clear it); no unfinished ticket relies on it.
- **Remediation:** Make the stop resumable (keep the batch `running`), or document it in the workflow stop table, with a test that the ticket is picked up again once its debt is resolved.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-batch.mjs#a-resumed-ticket-that-debt-now-blocks-ends-the-batch`
- **History:**
  - 2026-11-06: recorded: LOW at `scripts/ralph-batch.mjs:267`, spec axis (ticket 53 confirmation review, host-side)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (ticket 53 maintainer)

### TD-082: The batch report does not name tickets skipped for triage

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-06: triaged by the maintainer of ticket 53 with the confirmation review (harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 53 (`harness/53-risk-based-debt-gate`)
- **Evidence:** host-side confirmation review (Spec axis) of `4d0a7cb`, recorded in `issues/done/53-risk-based-debt-gate.md`
- **Components:** `scripts/ralph-batch.mjs:458`
- **Problem:** When a batch reaches `batch-limit` or `no-eligible-ticket` after skipping a `needs-triage` ticket, the FINISHED report does not mention it (only ralph-loop.sh logs it).
- **Impact:** A maintainer may not notice that a ticket waits for triage until the next batch stops on it.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when both independent host-side reviewers approved ticket 53's confirmation round. Triage 2026-11-06: fails safe (it can only hold work, never clear it); no unfinished ticket relies on it.
- **Remediation:** Append the `triage_ticket` line to the batch-limit and no-eligible-ticket stop details, with a test.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-batch.mjs#the-batch-report-does-not-name-tickets-skipped-for-triage`
- **History:**
  - 2026-11-06: recorded: LOW at `scripts/ralph-batch.mjs:458`, spec axis (ticket 53 confirmation review, host-side)
  - 2026-11-06: triaged: OPERABILITY, no owner: deferred, blocks no ticket (ticket 53 maintainer)

### TD-083: A slice can send an entry back to triage with a forged sighting line

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** SECURITY
- **Triage:** 2026-11-06: triaged by the maintainer of ticket 53 with the confirmation review (harness/53-risk-based-debt-gate)
- **Escalation:** none
- **Source:** ticket 53 (`harness/53-risk-based-debt-gate`)
- **Evidence:** host-side confirmation review (Spec axis) of `4d0a7cb`, recorded in `issues/done/53-risk-based-debt-gate.md`
- **Components:** `scripts/ralph-debt.mjs:657`
- **Problem:** `triageChangeErrors` accepts a Triage reset when any new history line contains `higher severity than recorded`; it does not check the recorder's exact line format or that a higher severity was reported.
- **Impact:** Only in the safe direction: a malicious slice could put tickets back into `needs-triage` (a stall that a maintainer re-triages), never clear one.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when both independent host-side reviewers approved ticket 53's confirmation round. Triage 2026-11-06: fails safe (it can only hold work, never clear it); no unfinished ticket relies on it.
- **Remediation:** Match the recorder's exact line format and the sighting's severity against the entry's Severity, with a test of a forged line.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-debt.mjs#a-slice-can-send-an-entry-back-to-triage-with-a-forged-sighting-line`
- **History:**
  - 2026-11-06: recorded: LOW at `scripts/ralph-debt.mjs:657`, spec axis (ticket 53 confirmation review, host-side)
  - 2026-11-06: triaged: SECURITY, no owner: deferred, blocks no ticket (ticket 53 maintainer)

### TD-084: Env stubs are restored inline, not in a finally or afterEach

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** UNTRIAGED
- **Triage:** pending
- **Escalation:** none
- **Source:** ticket 56 (`56-metrics-configuration-bootstrap`)
- **Evidence:** `.ralph/host-review/replay-20261108122117-29384/56-metrics-configuration-bootstrap.standards.json`
- **Components:** `apps/web/src/server/routers/health.test.ts:19`
- **Problem:** vi.unstubAllEnvs() runs as the last statement of the test body. If the caller or an assertion throws first, the stubbed SESSION_SECRET, DATABASE_URL and blank Upstash values leak into later tests in the same worker. session.test.ts has the same pattern at line 15.
- **Impact:** A failing test can cascade into misleading failures in other tests that share the worker. The existing trpc.test.ts uses a shared cleanup.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the host's own review approved the ticket. Escalate if its real impact grows.
- **Remediation:** Move vi.unstubAllEnvs() into afterEach, as trpc.test.ts and proxy.test.ts do, or wrap the body in try/finally.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/routers/health.test.ts#env-stubs-are-restored-inline-not-in-a-finally-or-aftereach`; `apps/web/src/server/routers/health.test.ts#env-stubs-are-unstubbed-only-on-the-success-path`
- **History:**
  - 2026-11-08: recorded: LOW maintainability at `apps/web/src/server/routers/health.test.ts:19`, standards axis; suggested risk MAINTAINABILITY, awaiting triage (ticket 56 host review standards, run replay-20261108122117-29384)
  - 2026-11-08: seen again: LOW missing_test at `apps/web/src/server/routers/health.test.ts:19`, spec axis (ticket 56 host review spec, run replay-20261108122117-29384)

### TD-085: Needless per-test dynamic imports and repeated failure assertions

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** UNTRIAGED
- **Triage:** pending
- **Escalation:** none
- **Source:** ticket 56 (`56-metrics-configuration-bootstrap`)
- **Evidence:** `.ralph/host-review/replay-20261108122117-29384/56-metrics-configuration-bootstrap.standards.json`
- **Components:** `apps/web/src/server/upstash-metrics.test.ts:52`
- **Problem:** Each test re-imports ./upstash-metrics dynamically with no module state or mocks that need it. Three tests repeat the same instanceof, HINCRBY and not-token assertions.
- **Impact:** Noise, and extra places to edit when the error contract changes.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the host's own review approved the ticket. Escalate if its real impact grows.
- **Remediation:** Import statically at the top of the file and extract a small helper such as expectRejectsNamingCommand(promise).
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/upstash-metrics.test.ts#needless-per-test-dynamic-imports-and-repeated-failure-asser`
- **History:**
  - 2026-11-08: recorded: LOW maintainability at `apps/web/src/server/upstash-metrics.test.ts:52`, standards axis; suggested risk MAINTAINABILITY, awaiting triage (ticket 56 host review standards, run replay-20261108122117-29384)

### TD-086: A failed resolution is cached for the life of the process

- **Status:** OPEN
- **Severity:** LOW
- **Risk:** UNTRIAGED
- **Triage:** pending
- **Escalation:** none
- **Source:** ticket 56 (`56-metrics-configuration-bootstrap`)
- **Evidence:** `.ralph/host-review/replay-20261108122117-29384/56-metrics-configuration-bootstrap.standards.json`
- **Components:** `apps/web/src/server/upstash-metrics.ts:84`
- **Problem:** createLazyMetrics caches the failure permanently, and the recorded outcome includes failures other than configuration errors, such as an unexpected throw from createRedisBookingMetrics. Fixing the environment needs a restart. The log line always says "metrics configuration is invalid".
- **Impact:** This is intended by AC5 and documented. If the construction step later gains non-config failure modes, the log text will mislead.
- **Justification:** Non-blocking under the merge policy (blocking: CRITICAL, HIGH); deferred when the host's own review approved the ticket. Escalate if its real impact grows.
- **Remediation:** Keep the behaviour. Restrict the try block to parseMetricsEnv, or word the log neutrally, so only configuration errors are labelled that way.
- **Target:** none
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `apps/web/src/server/upstash-metrics.ts#a-failed-resolution-is-cached-for-the-life-of-the-process`
- **History:**
  - 2026-11-08: recorded: LOW unverified_assumption at `apps/web/src/server/upstash-metrics.ts:84`, standards axis; suggested risk VERIFICATION, awaiting triage (ticket 56 host review standards, run replay-20261108122117-29384)

### TD-087: The workspace module's signal handlers have never been observed running

- **Status:** PLANNED
- **Severity:** MEDIUM
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`; `.ralph/reviews/20261110-harness-branches/sandbox-image-run.txt`
- **Components:** `scripts/ralph-test-workspace.mjs:314`
- **Problem:** On Windows, the only platform with a signal scenario so far, SIGTERM is a hard kill, so that scenario passes through the next run's recovery and passes with the handler deleted. SIGINT has no scenario at all.
- **Impact:** The handler could be broken on Linux, the platform the sandbox gate uses, and no test would show it. Directories would then wait for the next run's recovery.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. Recovery by the next run covers the same directories, so the cost is delay, not lost isolation. That recovery is observed on Windows; on Linux the module's tests pass in the sandbox image (2026-11-10), but no scenario separates the handler from recovery there.
- **Remediation:** Send SIGTERM and SIGINT to a child on Linux and assert the handler, not a later run, removed the session.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-test-workspace.mjs#sigterm-handler-never-observed`
- **History:**
  - 2026-11-10: recorded: MEDIUM missing_test at `scripts/ralph-test-workspace.mjs:314` (review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-088: The harness suite's cost on the sandbox volume is unmeasured

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of the combined tree of the harness branches, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`; `.ralph/reviews/20261110-harness-branches/sandbox-image-run.txt`
- **Components:** `scripts/ralph-test-workspace.mjs`; `scripts/ralph-verify.mjs:226`
- **Problem:** The module's own tests pass in the sandbox image (27 of 27 in 6 s, no sessions left, run by hand on 2026-11-10 in the container's /tmp). What no run has measured is the full harness suite in the --tools stage, which now writes fixtures to the /workspace volume instead of tmpfs, under an 1800 s limit shared with lint and typecheck. The sandbox suite does not exercise this, because the fixture's check has no test:harness.
- **Impact:** A timeout would first appear in a real gate run. It fails closed: it stops a merge and cannot pass bad work.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. Fails closed, and the module itself is now proven on Linux, so what remains is duration. It blocks no ticket: a slow stage would stop a run visibly, and the first production run will show the timing.
- **Remediation:** Time the --tools stage on the sandbox volume, and pass an external root such as /tmp/harness if it nears the limit.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-verify.mjs#workspace-module-never-run-in-container`
- **History:**
  - 2026-11-10: recorded: LOW unverified_assumption at `scripts/ralph-verify.mjs:226` (review of the combined tree of the harness branches, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-089: The guard for test files using the workspace module only sees tmpdir()

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`
- **Components:** `scripts/ralph-test-workspace.test.mjs`
- **Problem:** The guard flags a test file that calls tmpdir() without importing the module. A file using mktemp or reading TEMP directly escapes it, and a comment containing the module's path satisfies it. Every current file complies.
- **Impact:** A future test file could write to the system temporary directory unnoticed, which is how C: filled before.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. All current files comply, and the docs state the guard's limit.
- **Remediation:** Extend the guard to direct TEMP reads and mktemp, and match the import rather than any text.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-test-workspace.test.mjs#workspace-guard-only-sees-tmpdir`
- **History:**
  - 2026-11-10: recorded: LOW test_quality at `scripts/ralph-test-workspace.test.mjs:495` (review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-090: The Git discovery test can pass without the ceiling

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`
- **Components:** `scripts/ralph-test-workspace.test.mjs`
- **Problem:** With an external RALPH_TEST_TMP_ROOT no repository sits above the fixture, so the test passes even if GIT_CEILING_DIRECTORIES is not set.
- **Impact:** The test proves the ceiling only when the root is inside the repository, which is the default.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. The default root does exercise the ceiling, and inherited Git variables have their own test.
- **Remediation:** Create a repository above the fixture inside the test.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-test-workspace.test.mjs#git-discovery-test-can-pass-without-ceiling`
- **History:**
  - 2026-11-10: recorded: LOW test_quality at `scripts/ralph-test-workspace.test.mjs:440` (review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-091: The shell test suites keep inherited Git repository variables

- **Status:** RESOLVED
- **Severity:** HIGH
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-13: maintainer decision to rate it HIGH and fix it before the harness branches merge, after reviewing the classification Claude drafted on 2026-11-10
- **Escalation:** Rated HIGH by the maintainer on 2026-11-13: the same exposure in the Node suites was rated HIGH by two of three reviewers and fixed, and a real trigger was observed. Git 2.45 exports an absolute GIT_DIR and GIT_INDEX_FILE to a hook running in a linked worktree, which this repository uses. As a HIGH it blocks the merge, so it was fixed instead of deferred.
- **Source:** review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`
- **Components:** `scripts/sandbox.test.sh`; `scripts/ralph-loop.test.sh`; `scripts/ralph-sessions.test.sh`; `scripts/ralph-resume.test.sh`; `scripts/ralph-lead.test.sh`
- **Problem:** None of these suites clears GIT_DIR, GIT_WORK_TREE or the other repository-local variables, so an inherited GIT_DIR outranks discovery in their fixtures.
- **Impact:** Running the suites from a Git hook in a linked worktree sends a fixture's `git add` and `commit` to the real repository and its index. `git rebase -x`, the first review's example, does not export GIT_DIR on Git 2.45 (observed 2026-11-13).
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. No hook or workflow in the repository exports these variables, so it needs a manual invocation. The docs state the limit.
- **Remediation:** Clear Git's repository-local variables at the start of each suite.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** Every `scripts/*.test.sh` sources `scripts/test-git-isolation.sh` on the line after `set -Eeuo pipefail`, before any fixture exists. It unsets the variables `git rev-parse --local-env-vars` names, the same list `scripts/ralph-test-workspace.mjs` clears for the Node suites, and stops the suite if Git cannot name them. No suite was run end to end with an inherited GIT_DIR: the helper's behaviour is proven on a decoy repository, and each suite's use of it by a wiring check.
- **Verification:** `scripts/test-git-isolation.test.mjs::without it, a fixture commit lands in the repository the caller's GIT_DIR names`; `scripts/test-git-isolation.test.mjs::keeps a fixture's commit in the fixture when the caller exports GIT_DIR and GIT_INDEX_FILE`; `scripts/test-git-isolation.test.mjs::clears every repository-local variable the running Git names`; `scripts/test-git-isolation.test.mjs::is sourced by every bash test suite before anything else runs`
- **Fingerprints:** `scripts/sandbox.test.sh#shell-suites-keep-inherited-git-variables`
- **History:**
  - 2026-11-10: recorded: MEDIUM unverified_assumption at `scripts/sandbox.test.sh:253` (review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: CORRECTNESS, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)
  - 2026-11-10: rated MEDIUM, not the reviewer's LOW: the same exposure in the Node suites was rated HIGH by two reviewers and MEDIUM by one, and `test:harness` runs both (confirmation review of the combined tree)
  - 2026-11-13: rated HIGH and owned by the branch that fixes it ahead of ticket 58 (maintainer decision, 2026-11-13, after Claude's independent review of the triage): the Node twin was rated HIGH, and a hook in a linked worktree was observed to export GIT_DIR and GIT_INDEX_FILE
  - 2026-11-13: resolved on branch `fix/td-091-shell-suite-git-isolation`: the suites source `scripts/test-git-isolation.sh` first; removing its `unset`, or the source line from any suite, turns the named tests red (sabotage check)

### TD-092: Sandbox lead checks match log wording

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`
- **Components:** `scripts/sandbox.test.sh:528`; `scripts/sandbox.test.sh:577`
- **Problem:** check_lead_started and the red-base scenario match log prose although sessions_of exists. The negative grep for the session line would pass vacuously if the message were reworded.
- **Impact:** A reworded log line can make the red-base check meaningless. check_lead_started in the same suite would catch that rewording.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. The same suite's positive check catches the rewording, so the gap is narrow.
- **Remediation:** Assert on sessions_of in place of the log lines.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/sandbox.test.sh#sandbox-lead-checks-match-log-wording`
- **History:**
  - 2026-11-10: recorded: LOW test_quality at `scripts/sandbox.test.sh:577` (review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-093: The lead-interrupt scenario accepts and stops any container of the image

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** VERIFICATION
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/first-review.txt`
- **Components:** `scripts/sandbox.test.sh:637`
- **Problem:** The check selects the first running container of the sandbox image and never asserts that lead-started appeared. This line predates the fixture change.
- **Impact:** A concurrent sandbox run satisfies the check after a baseline stop, and docker stop then hits that other run. The suite still fails through check_lead_started.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. Sandbox runs on this host are not concurrent, and the suite still fails through check_lead_started.
- **Remediation:** Assert the marker exists and select only this run's container.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/sandbox.test.sh#lead-interrupt-accepts-any-container`
- **History:**
  - 2026-11-10: recorded: LOW test_quality at `scripts/sandbox.test.sh:637` (review of branch `fix/sandbox-lead-baseline-fixture`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: VERIFICATION, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-094: A root spelled with an 8.3 short name passes the repository check

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** CORRECTNESS
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** confirmation review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/confirmation-review.txt`
- **Components:** `scripts/ralph-test-workspace.mjs:88`
- **Problem:** realpathSync keeps 8.3 short names on Windows, so E:\Balazs\TICKET~1 is not recognised as the repository, and neither is a failure-injection folder reached that way.
- **Impact:** A root so spelled creates sessions/ inside the repository or evidence folder. Deletion stays confined to sessions/session-*, so no real file is lost.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. Needs a deliberately short-named root, and deletion stays confined.
- **Remediation:** Resolve with realpathSync.native, which expands short names, and test it on a volume with 8.3 names.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-test-workspace.mjs#workspace-root-8-3-name-passes-repository-check`
- **History:**
  - 2026-11-10: recorded: LOW unverified_assumption at `scripts/ralph-test-workspace.mjs:88` (confirmation review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: CORRECTNESS, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)

### TD-095: A root on a missing drive fails with a raw ENOENT

- **Status:** PLANNED
- **Severity:** LOW
- **Risk:** OPERABILITY
- **Triage:** 2026-11-10: maintainer's instruction to triage the harness branches' review findings; classification drafted by Claude for the maintainer's review of this commit
- **Escalation:** none
- **Source:** confirmation review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice
- **Evidence:** `.ralph/reviews/20261110-harness-branches/confirmation-review.txt`
- **Components:** `scripts/ralph-test-workspace.mjs:109`
- **Problem:** resolveThroughLinks can throw ENOENT outside the try that names RALPH_TEST_TMP_ROOT, so the error does not say which setting is at fault.
- **Impact:** The run still fails with no fallback to the system's temporary directory; only the message is less helpful.
- **Justification:** Not blocking under the merge policy, and no product ticket relies on it: it concerns the harness's own tests. It still fails closed.
- **Remediation:** Wrap the call so the error names RALPH_TEST_TMP_ROOT, and test a missing drive.
- **Target:** ticket 58 (`issues/58-harness-test-workspace-hardening.md`)
- **Blocks:** none
- **Acceptance:** none
- **Resolution:** none
- **Verification:** none
- **Fingerprints:** `scripts/ralph-test-workspace.mjs#workspace-root-missing-drive-raw-enoent`
- **History:**
  - 2026-11-10: recorded: LOW missing_test at `scripts/ralph-test-workspace.mjs:109` (confirmation review of branch `harness/test-workspace-isolation`, 2026-11-10, not a slice)
  - 2026-11-10: triaged: OPERABILITY, owned by ticket 58, blocks no ticket (maintainer's instruction of 2026-11-10; classification drafted by Claude)
<!-- ralph-debt:end -->
