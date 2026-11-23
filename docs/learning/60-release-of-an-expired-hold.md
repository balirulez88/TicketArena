# 60: Lejárt hold felszabadítása

Ticket: `issues/60-release-of-an-expired-hold.md` · commit: nincs még · ADR: [0005](../adr/0005-postgres-seat-state-row-locks.md) · előzmények: [13](13-release-hold.md), [14](14-hold-expiry.md)

## Probléma

A vevő a "Release seats" gombra kattint, de a hold 30 perces ideje már lejárt. A rendszer oldaláról a lejárat kétféleképpen látszhat: a sweeper már `EXPIRED`-re állította, vagy a sor még `HELD`, csak a `holdExpiresAt` telt el. Korábban a második esetben a release sikerült (`RELEASED`), az elsőben `HOLD_NOT_ACTIVE` jött, miközben `placeOrder` mindkettőre `HOLD_EXPIRED`-et mond. A vevő ugyanarra a helyzetre kétféle választ kapott attól függően, hogy a sweeper épp lefutott-e.

## Döntés

1. **Egy szabály mindenhol**: a hold érvényes, ha `T < holdExpiresAt`. A sweeper csak _eventual_ állapotot ad (15 mp-enként fut), a lazy szabály az azonnali választ. A válasz ezért nem függhet attól, hogy a sweeper hol tart. A `releaseHold` ezt `assertHeld` (swept `EXPIRED` → `HOLD_EXPIRED`) és `isExpiredAt` (unswept) hívással érvényesíti (`packages/booking/src/booking-service.ts`).
2. **A `T`-t a zárak után olvassuk, és írás előtt utasítunk el**: a `releaseHold` a buyer lock, a hold sor és a székek zárolása után hívja a `clock.now()`-t, és ha lejárt, `HoldExpiredError`-t dob, mielőtt bármit írna. A tranzakció visszagördül, a hold `HELD` marad, nincs `hold.released` esemény. A székeket a sweeper szabadítja fel és ő írja a `hold.expired` eseményt, így a `hold.released` és a `hold.expired` nem keveredik. A székek mindkét úton `AVAILABLE`-ek lesznek.
3. **Hibakód-leképezés**: `HOLD_EXPIRED` → tRPC `PRECONDITION_FAILED`, mint `placeOrder`-nél; `HOLD_NOT_ACTIVE` marad `CONFLICT` (`apps/web/src/server/routers/booking.ts`). A kliens ugyanazt a `checkoutFailure` parsert használja. A UI (`hold-controls.tsx`) a `HOLD_EXPIRED` választ a hold végének kezeli (`onExpired`, "Your hold expired"), nem újrapróbálható hibának, mert a seatek úgyis felszabadulnak.

## Alternatívák

| Alternatíva                                               | Előny                                 | Hátrány                                                                             | Miért nem itt                                                   |
| --------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Lejárt, unswept hold release-ét engedni (régi viselkedés) | Barátságos, a székek azonnal szabadok | A válasz a sweeper időzítésétől függ; a `hold.released` és `hold.expired` keveredik | A ticket egy szabályt kér mindenhol (`T < holdExpiresAt`)       |
| Release-nél a hold átállítása `EXPIRED`-re                | Nem kell a sweepernek várni           | Második író a lejárati útvonalon; `hold.expired` eseményt is írni kellene           | Az expiry a sweeper dolga; a hibaág ne írjon                    |
| Mindenre `HOLD_NOT_ACTIVE` (`CONFLICT`)                   | Egyszerű, egy hibakód                 | A vevő nem tudja, hogy lejárt; eltér a `placeOrder`-től                             | A kliens különbséget tesz lejárat és "nem aktív" között         |
| Tiszta kliensoldali lejárat-ellenőrzés                    | Nem kell szerver                      | A kliens órája eltérhet; a szerver dönt a lejáratról                                | Az architektúra szerint csak a szerver dönt (docs/architecture) |

## Fogalmak

- **Lazy expiry vs. eventual state**: a lejárat olvasáskor érvényesül azonnal; a tárolt `EXPIRED` státusz csak később, a sweeper után áll be.
- **Linearization point**: az egyetlen pillanat (`T`, a zárak után), ahol a döntés megtörténik.
- **Outbox**: az állapotváltozással azonos tranzakcióban írt esemény. Itt a hibaág nem ír, ezért nincs esemény.
- **Rollback**: a dobott hiba visszagörgeti a tranzakciót, így a "refuse before any write" valójában nulla változás.
- **`PRECONDITION_FAILED` vs. `CONFLICT`**: az előbbi "a feltétel (élő hold) nem áll fenn", az utóbbi állapotütközés.

## Mi romolhat el

| Hiba                                                            | Teszt                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unswept lejárt hold release-e sikerül vagy ír (`hold.released`) | `release-hold.test.ts`: "refuses an expired hold the sweeper has not reached ..." (hold `HELD`, székek `HELD`, 0 esemény) |
| Már swept hold `HOLD_NOT_ACTIVE`-et ad                          | "refuses a hold the sweeper already expired with HOLD_EXPIRED"                                                            |
| Off-by-one a határon                                            | "releases a hold one millisecond before holdExpiresAt" és a `T = holdExpiresAt` eset                                      |
| Hibakód eltér `placeOrder`-től az API-n                         | `booking.test.ts`: "HOLD_EXPIRED is a PRECONDITION_FAILED, as for placeOrder"                                             |
| A UI újrapróbálható hibát mutat, a hold ott marad               | `queue-and-hold.test.tsx`: "a release refused with HOLD_EXPIRED ends the hold ..."                                        |
| `RELEASED`/ordered hold összetévesztése lejárttal               | a `HOLD_NOT_ACTIVE` tesztek a `release-hold.test.ts`-ben maradnak                                                         |

## Interjúkérdések

1. **Miért nem engedjük a lejárt hold release-ét, ha a székek úgyis szabadok lesznek?** Mert a válasz nem függhet a sweeper időzítésétől: egy szabály van (`T < holdExpiresAt`), és `placeOrder` is ezt használja. A release sikere esemény-ellentmondást is okozna (`hold.released` egy már lejárt holdra).
2. **Miért olvassuk a `T`-t a zárak után?** A zárak előtt más tranzakció még módosíthatja a hold-ot (pl. a sweeper), így a döntés elavulhatna. A zárak után a státusz és az idő konzisztens (ADR 0005, lásd 14).
3. **Miért `PRECONDITION_FAILED`, és miért marad a `HOLD_NOT_ACTIVE` `CONFLICT`?** A lejárt hold ugyanaz a feltételhiba, mint `placeOrder`-nél, a kliens egy parserrel kezeli. A `RELEASED`/`ORDERED` valódi állapotütközés, más a teendő.
4. **Mit csinál a UI `HOLD_EXPIRED` válasznál?** Lezárja a hold-ot ("Your hold expired"), nem kínál újrapróbálást, mert a székeket a sweeper amúgy is felszabadítja.
5. **Hogyan teszteled a határt?** Injektált órával (`at(...)`) pontosan `holdExpiresAt`-nél (elutasít) és 1 ms-mal előtte (sikerül); SQL `now()` ezt nem tenné lehetővé.
