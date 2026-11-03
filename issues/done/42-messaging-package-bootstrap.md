# 42: Messaging package bootstrap

**What to build:** the empty `messaging` workspace package that ticket 06 builds into: package manifest, TypeScript and Vitest configuration, workspace and lockfile integration, and one test that proves the package's tests are discovered, executed and reach the real Postgres and NATS. No relay or consumer logic. An infrastructure change, reviewed and merged outside Ralph: a RED phase cannot run in a package that does not exist yet.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `packages/messaging` has `package.json` (`@ticketarena/messaging`, `exports` → `src/index.ts`, `typecheck` and `test` scripts without `--passWithNoTests`), `tsconfig.json` extending the base, and `vitest.config.ts` with the shared test-infra global setup.
- [x] The package is in the workspace and the lockfile (`pnpm install --frozen-lockfile` passes); `turbo run test` and `turbo run typecheck` include it.
- [x] `src/test-environment.test.ts` executes against real Postgres (migrated `outbox_events`) and real JetStream.
- [x] `src/index.ts` exports nothing yet; no business logic.
- [x] A test written in the package is accepted as RED only when it executes and fails (`scripts/ralph-red.mjs`), verified by hand against this package.
- [x] `docs/architecture` lists the package.
