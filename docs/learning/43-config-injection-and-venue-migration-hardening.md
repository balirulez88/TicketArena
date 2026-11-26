# 43: Konfiguráció injektálása és a venue migráció megerősítése

Ticket: `issues/43-config-injection-and-venue-migration-hardening.md`; commit: még nincs; ADR: 0010 (valódi infrastruktúrán futó tesztek). Megoldott debt: TD-001, TD-003, TD-010, TD-011, TD-028.

## Probléma

A `packages/db` seed parancsa maga olvasta a `DATABASE_URL`-t, ami sérti a "package soha nem olvas `process.env`-et" szabályt (TD-001), és a parancsot egy teszt sem futtatta (TD-011). A `seedCatalog` a runtime barrelből is elérhető volt, így a production modulgráf része lett (TD-010). A tRPC context minden kérésnél felépítette a Prisma klienst, ezért `DATABASE_URL` nélkül a `health.check` is elhasalt (TD-003). Végül a `venues.name` unique index migrációja elbukik, ha az adatbázisban már van két azonos nevű venue (TD-028).

## Döntés

1. **A seed parancs a worker appba költözött** (`apps/worker/src/seed-main.ts`, `pnpm --filter @ticketarena/worker db:seed`). A `parseSeedEnv` zoddal csak a `DATABASE_URL`-t validálja, és a mezőt megnevezve bukik. A worker a természetes hely: ő is a direct URL-en, `pg` driverrel dolgozik.
2. **Külön `./seed` entry point** (`@ticketarena/db/seed`): a tesztek és a parancs innen importálják a `seedCatalog`-ot, a runtime `index.ts` nem exportálja.
3. **Lusta `ctx.db()`**: a `lazyBooking` csak az első `db()` hívásnál olvassa és validálja a környezetet, és megtartja a klienst; a hibás olvasást nem cache-eli. A `bookingTimeouts` érték marad, ugyanabból a `LazyBookingRuntime`-ból, így a kliens tranzakciós kerete és a booking service timeoutjai továbbra is egy értékből jönnek.
4. **Új, előtte futó migráció** (`20261030025000_merge_duplicate_venues`) a meglévő szerkesztése helyett. Névenként a legkisebb `id`-jű venue marad; a duplikátumok eseményei és szekciói átkerülnek rá, az azonos nevű szekciók és azonos címkéjű sorok összeolvadnak, a székek átkerülnek, szék soha nem törlődik.

## Alternatívák

| Alternatíva                                  | Előny                  | Hátrány                                                                 | Miért nem itt                                             |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| URL parancssori argumentumként               | a package-ben maradhat | a titok látszik a process listában, a shell úgyis env-ből adja          | biztonsági és kényelmi okból rosszabb                     |
| Kivétel rögzítése CLAUDE.md-ben vagy ADR-ben | nincs kódváltozás      | a szabály gyengül, precedenst teremt                                    | a ticket a szabály betartását kéri                        |
| Getter a contexten (`get db()`)              | a típus nem változik   | egy `{ ...ctx }` spread csendben meghívja, és visszahozza a hibát       | a tesztek és middleware-ek is spreadelik a contextet      |
| A meglévő unique migráció szerkesztése       | egy fájl               | a checksum megváltozik, a `prisma migrate dev` resetet kér a dev DB-ken | a már migrált adatbázisoknak az új migráció a biztonságos |
| Csak hibaüzenettel bukó migráció             | egyszerű               | a deploy továbbra is elakad                                             | a TD-028 kifejezetten összevonást kér                     |

## Fogalmak

- **Konfiguráció injektálása**: a környezetet csak az app határa olvassa és validálja, a package-ek paraméterként kapják.
- **Lusta erőforrás**: csak az első használatkor épül fel, így a nem használó kérések nem függnek tőle.
- **Survivor szabály**: determinisztikus döntés, melyik duplikátum marad; itt a legkisebb `id`.
- **Subpath export**: a `package.json` `exports` mezőjében külön belépési pont, ami szűkíti a runtime felületet.

## Mi romolhat el

| Hibamód                                                         | Teszt                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Egy package újra `process.env`-et olvas                         | `packages/db/src/no-process-env.test.ts` (TypeScript AST, kommentek nem számítanak) |
| A `seedCatalog` visszakerül az `index.ts`-be                    | `packages/db/src/entry-points.test.ts`                                              |
| A seed parancs nem várja meg a seedet vagy nem bont kapcsolatot | `apps/worker/src/seed-main.test.ts`: kilépési kód, katalógus, 9 s-os kilépési határ |
| `DATABASE_URL` nélkül a health check elhasal                    | `apps/web/src/server/lazy-database.test.ts`                                         |
| A unique index migráció duplikátumokon elbukik                  | `packages/db/src/venue-merge-migration.test.ts`                                     |
