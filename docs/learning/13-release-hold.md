# 13: Release a hold

Ticket: `issues/done/13-release-hold.md` · commit `2f65fa5` · ADR: 0003 (transactional outbox), 0005 (Postgres seat state, row locks)

## Probléma

A vásárló (buyer) meggondolja magát, és visszaadja a hold-ját. A rendszer oldaláról ennek azonnal fel kell szabadítania a helyeket, hogy más is lefoglalhassa őket, nem kell megvárni a lejáratot (ticket 14). Közben a hold-ra egyszerre dolgozhat egy `placeOrder`, egy másik `releaseHold` vagy a sweeper, és a hold-ra közben egy másik buyer is rátehette a kezét, ha az lejárt.

## Döntés

A `booking.releaseHold` (`apps/web/src/server/routers/booking.ts`) a `releaseHold` service-metódust hívja (`packages/booking/src/booking-service.ts`). Egyetlen tranzakcióban fut le:

1. **Lock sorrend**: buyer advisory lock, majd a hold sor `FOR UPDATE`, majd a seat sorok `ORDER BY id FOR UPDATE`. Ugyanez a sorrend a `holdSeats`/`placeOrder` esetében is, ezért nincs deadlock (ADR 0005). A hold sor lock-ja sorosítja a `placeOrder`-rel és egy másik release-zel.
2. **Csak a saját seat-ek**: csak azokat a seat-eket szabadítja fel, amelyeknek még `holdId = ez a hold` és `HELD` az állapotuk. Ha egy lejárt hold seat-jét közben másik hold átvette, azt nem bántjuk.
3. **Outbox**: ugyanabban a tranzakcióban egy `hold.released` esemény (`{ holdId, seatIds }`, a ténylegesen felszabadított seat-ekkel). Az esemény akkor és csak akkor létezik, ha a release commitolt.

Hibák: nem a tulajdonos hívja, vagy nincs ilyen hold: `NOT_FOUND` (nem szivárogtatjuk, hogy létezik). Nem `HELD` státusz: `HOLD_NOT_ACTIVE`, tRPC-ben `CONFLICT`. Egy lejárt, de még nem sweepelt hold még `HELD`, ezért release-elhető. A waiting-room slotot nem érinti (ticket 30).

## Alternatívák

| Alternatíva                                                          | Előny                 | Hátrány                                                                    | Miért nem itt                                      |
| -------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Várni a lejáratra (sweeper)                                          | Nincs új kód          | A seat-ek percekig foglaltak maradnak                                      | A ticket célja az azonnali felszabadítás           |
| Seat-ek felszabadítása `eventId`/buyer alapján, nem `holdId` alapján | Egyszerűbb lekérdezés | Idegen hold seat-jét is felszabadíthatja                                   | A `holdId` feltétel a helyesség lényege            |
| Hold törlése (`DELETE`)                                              | Egyszerű              | Elvész az audit, nincs `RELEASED` állapot és `correlationId` az eseményhez | A státusz-gép és az esemény kell                   |
| Esemény publikálása commit után közvetlenül NATS-ra                  | Kevesebb mozgó rész   | Összeomláskor az állapot és az esemény szétcsúszik (dual write)            | Az outbox ugyanabban a tranzakcióban ír (ADR 0003) |

## Fogalmak

- **Row lock (`FOR UPDATE`)**: a sort addig más tranzakció nem módosíthatja, amíg a miénk commitol. Seat állapotot ez dönt el, nem a Redis.
- **Lock order**: ha mindenki ugyanabban a sorrendben zár (buyer, hold, seat id szerint), nem alakul ki kölcsönös várakozás (deadlock).
- **Transactional outbox**: az esemény ugyanabban a DB tranzakcióban kerül egy táblába, ahonnan később külön folyamat publikálja.
- **Idempotencia / egyszeri végrehajtás**: itt nem kulcs, hanem státusz-ellenőrzés a lock alatt adja: a második release `HOLD_NOT_ACTIVE`.
- **Takeover**: lejárt, még nem sweepelt hold seat-jét egy másik buyer újra lefoglalja.

## Mi mehet félre

| Hiba                                                                          | Teszt                                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Egyszerre több release ugyanarra a hold-ra: kétszer szabadít fel, két esemény | `release-hold.test.ts`: "concurrent releases of one hold release it exactly once" (1 siker, 1 outbox sor) |
| Másik hold seat-jének felszabadítása                                          | "frees only the seats that still carry this hold's id"                                                    |
| Már rendelt (`IN_CHECKOUT`) vagy már release-elt hold újra release-elése      | "refuses a hold that is no longer HELD" (a seat-ek `IN_CHECKOUT` maradnak, 1 esemény)                     |
| Idegen buyer release-eli a hold-ot, vagy létezése kiderül                     | "hides the hold from anyone but its owner" és router: `NOT_FOUND`                                         |
| Felszabadított seat nem azonnal foglalható                                    | "lets another buyer hold the released seats immediately"                                                  |
| Hibás `holdId`                                                                | router teszt: `BAD_REQUEST`, az üzenet nevesíti a `holdId` mezőt                                          |

Megjegyzés: a takeover teszt közvetlenül írja a `holdId`-t, nem valódi lejárt hold átvételét hajtja (a commit follow-up listáján szerepel).

## Interjúkérdések

1. **Miért kell a seat-ek lekérdezésében `holdId` feltétel?** Mert a lejárt, nem sweepelt hold seat-jét más hold átveheti. A feltétel nélkül a release idegen foglalást törölne. A teszt: "frees only the seats that still carry this hold's id".
2. **Mi akadályozza meg, hogy a release és a `placeOrder` ütközzön?** Mindkettő a hold sort `FOR UPDATE`-tel zárja, és a lock alatt újraolvassa a státuszt. Aki második, `HOLD_NOT_ACTIVE`-ot kap. Az előzetes, lock nélküli olvasás csak a buyer lock kiválasztásához kell.
3. **Miért outbox és nem közvetlen publish?** Két rendszerbe (Postgres, NATS) nem lehet atomikusan írni. Az outbox miatt az esemény pontosan akkor létezik, ha a release commitolt (ADR 0003).
4. **Miért `NOT_FOUND` és nem `FORBIDDEN` idegen hold-ra?** Hogy ne derüljön ki, létezik-e a hold. A `getOrder` is így működik.
5. **Miért nem szabadítja fel a waiting-room slotot?** A release nem fejezi be a vásárlást, a buyer újra próbálkozhat. A slot logika a ticket 30-ban jön, és ezt a doksi rögzíti.
