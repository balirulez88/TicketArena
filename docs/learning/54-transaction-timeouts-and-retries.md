# 54: Tranzakció timeoutok és retry

Ticket: `issues/54-transaction-timeouts-and-retries.md` · commit: még nincs (`devflow/run-202611231133` ág) · ADR: [0005](../adr/0005-postgres-seat-state-row-locks.md), [0010](../adr/0010-real-infrastructure-tests.md)

## Probléma

Nagy terhelésnél sok vevő ugyanazokat a székeket akarja. A `holdSeats` és a `placeOrder` sor-zárakat (row lock) szerez, ezért két tranzakció egymásra várhat, vagy akár deadlockba kerülhet. Timeout nélkül a kérés örökké lóghat, korlátlan retry mellett pedig terhelést adna a terheléshez. A vevő ezért sem a végtelen várakozást, sem a nyers 500-as hibát ne kapja. Átmeneti torlódásra kapjon újrapróbálható `BOOKING_BUSY` választ (tRPC `TOO_MANY_REQUESTS`), valódi hibára pedig látható internal errort.

## Döntés

1. **Korlátos várakozás tranzakciónként.** Minden booking tranzakció elején `set_config('lock_timeout', '3000ms', true)` és `statement_timeout` 5 s fut (`booking-service.ts`). A harmadik paraméter `true`, vagyis ez a `SET LOCAL`: csak a tranzakció végéig él, a pool-ban visszamaradó kapcsolat újra a szerver alapértékeit használja. Az érték egyetlen `BookingTimeouts` objektumból jön (`booking-transaction.ts`). Ez adja a `SET LOCAL` értékeket és a Prisma `timeout`/`maxWait` opciókat is (`bookingTransactionOptions`). Az `apps/web/src/server/trpc.ts` egyetlen `BookingRuntime`-ban (`db` + `timeouts`) adja át mindkettőt, ezért nem térhetnek el.
2. **A teljes tranzakciót újrafuttatjuk, de csak három hibakódra.** A `transaction-errors.ts` `classifyBookingError` függvénye az SQLSTATE-et a Prisma `meta.driverAdapterError.cause.originalCode` mezőből olvassa. A `40P01` (deadlock), `55P03` (lock timeout) és `40001` (serialization failure) `retryable`. Legfeljebb 3 retry fut, minden retry előtt injektált random forrásból számolt jitterrel (20-200 ms, `retryDelayMs`) és injektált timerrel. Ha a 4. kísérlet is elbukik, `BookingBusyError` lesz belőle.
3. **Terhelés ≠ hiba.** `busy`: a pool-acquire timeout (`timeout exceeded when trying to connect`), a Prisma tranzakció-indítási `P2028` és a `statement_timeout` miatti `57014`. `internal`: connect timeout (`Connection terminated due to connection timeout`), a `pg_cancel_backend` okozta `57014` (más az üzenete) és a futás közbeni `P2028`, mert ott a munka akár már commitolt is. Ezeket nem szabad vakon újrapróbálni.

**Költségvetés.** A Prisma `timeout` = 3 zár × 3 s + 5 s + 1 s margó = 15 s, mert a leghosszabb út (`placeOrder`) három zárat vár. A legrosszabb eset 4 kísérlet × (3 s `maxWait` + 15 s) + 3 × 200 ms = **72,6 s** (`worstCaseBookingBusyMs`). Ez a szám számolható, nem becsült.

## Alternatívák

| Alternatíva                                 | Előny                   | Hátrány                                                         | Miért nem itt                                                        |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Nincs timeout, nincs retry                  | Egyszerű                | Lógó kérések, a deadlock áldozata nyers hibát kap               | A ticket célja pont ez ellen szól                                    |
| Minden hiba retry                           | Kevés kód               | Unique violation vagy runtime timeout újrafuttatása hibás lehet | Csak az a három kód biztos, hogy teljes rollback után újrapróbálható |
| Session-szintű `SET` (nem `LOCAL`)          | Egyszer kell beállítani | A pool-ban a kapcsolaton marad, más kód is örökli               | Teszt: tranzakció után a szerver alapértékei látszanak               |
| Konstans jitter / azonnali retry            | Kiszámítható            | Az ütköző vevők szinkronban újra ütköznek                       | A random jitter szétszórja őket (a teszt két értékkel ellenőrzi)     |
| Külön literál a Prisma és a service oldalon | Nincs közös típus       | Eltérhetnek: a Prisma lejárathat egy egészséges tranzakciót     | Egy `BookingRuntime`, egy forrás                                     |

## Fogalmak

- **`lock_timeout` / `statement_timeout`**: Postgres beállítások. Az első a zárra várást, a második egy utasítás futását korlátozza. Lejáratkor `55P03`, illetve `57014`.
- **Deadlock (`40P01`)**: két tranzakció egymás zárára vár. Postgres az egyiket megszakítja, a másik lefut.
- **`40001` serialization failure**: egyidejűség miatt megszakított tranzakció. A booking READ COMMITTED alatt fut, ezért itt csak tesztben, triggerrel keltjük.
- **Jitter**: véletlen késleltetés retry előtt, hogy az ütköző kérések ne ismétlődjenek szinkronban.
- **`P2028`**: a Prisma tranzakciós API hibakódja. Három különböző helyzetet fed le (indítás-timeout, futás-timeout, már lezárt tranzakció), ezért az üzenet alapján kell szétválasztani.
- **`BOOKING_BUSY`**: újrapróbálható túlterheltség-jelzés a kliensnek. A metrika a nem ismert eseményt az `"unknown"` kulcs alá számolja.

## Mi mehet félre

| Hibamód                                             | Teszt                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A timeout session-szintű, a pool-ban "ragad"        | `transaction-retry.test.ts`: `3s`/`5s` trigger-rel mérve, utána szerver alapérték           |
| Unique violation újrafuttatása                      | `a unique violation ... exactly one attempt`                                                |
| Zár-timeout végtelen retryba fut                    | `makes 4 attempts, then BOOKING_BUSY` (`deadlock_retry` 3, `booking_busy` 1), hold és order |
| Deadlock áldozata hibával tér vissza                | `the service, made the deadlock victim, retries ...`: pontosan egy hold                     |
| Félig lefutott 40001 kísérlet sor-maradványt hagy   | `a real 40001 on the first attempt only ...`: az első kísérlet nem hagy sort                |
| Prisma lejáratja a lassú, de egészséges tranzakciót | `transaction-budget.test.ts`: mindhárom záron vár és sikerül, nincs `P2028`                 |
| Connect timeout `BOOKING_BUSY`-nek látszik          | `connect-timeout.test.ts`: lyukas TCP listener, pg és Neon is                               |
| Külső `pg_cancel_backend` busy-nak minősül          | `transaction-busy.test.ts`: `57014` két üzenettel, router `INTERNAL_SERVER_ERROR`           |
| Futás közbeni `P2028` retry-olódik                  | `a transaction past its own runtime timeout ...`: egy kísérlet, internal                    |
| Az `index.ts` kiszivárogtat tesztkonstansokat       | `public-surface.test.ts`: engedélylista                                                     |

Minden Postgres/driver garanciát valódi adatbázison bizonyítunk (ADR 0010): latch-ekkel tartott blokkolók és `pg_stat_activity` / `pg_blocking_pids` várakozás-figyelés, nem kézzel gyártott hibaobjektumokkal.

## Interjúkérdések

1. **Miért próbálható újra a teljes tranzakció `40P01`/`55P03`/`40001` után?** Ezeknél Postgres az egész tranzakciót visszagörgeti, így nincs részeredmény. A kód ezért a tranzakció elejéről indul, és minden zárat újraszerez. Más hibáknál, például futás-timeoutnál, a commit eredménye bizonytalan lehet.
2. **Miért `SET LOCAL`, és mi történne session-szinten?** A pool kapcsolatokat újrahasznál, ezért a session-szintű beállítás más kérésekre is átszivárogna. Nálunk a teszt egy 1 méretű poolon ellenőrzi, hogy a tranzakció után a szerver alapértékei látszanak.
3. **Hogyan számoltátok a Prisma timeoutot?** A leghosszabb út három zárra vár (buyer advisory lock, hold sor, székek), ezért 3 × `lock_timeout` + `statement_timeout` + margó. Ha a Prisma alapértelmezett 5 s-ja érvényes lenne, még azelőtt `P2028`-cal lejáratna egy egészséges tranzakciót, hogy Postgres jelezné az igazi eredményt.
4. **Miért nem minden timeout `BOOKING_BUSY`?** A `BOOKING_BUSY` azt ígéri, hogy később újra lehet próbálni. Ez igaz a pool-telítésre és a `statement_timeout`-ra. Connect timeout viszont infrastruktúra-hiba, a külső cancel pedig ismeretlen eredetű, ezért ezek internal errorok maradnak.
5. **Miért jitter, és mi a legrosszabb válaszidő?** A jitter szétszórja az ütköző vevők újrapróbálkozását. A felső korlát 72,6 s, amelyet a `worstCaseBookingBusyMs` ad. A teszt a képlet minden tagját külön mozgatja.
