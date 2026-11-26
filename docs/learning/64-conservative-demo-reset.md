# 64: Konzervatív demo reset

Ticket: `issues/64-conservative-demo-reset.md`. ADR: [0005](../adr/0005-postgres-seat-state-row-locks.md) (a székek állapota Postgresben), [0009](../adr/0009-service-schema-ownership.md) (nincs cross-schema törlés). Commit: még nincs.

## Probléma

Az `admin.resetDemo` korábban törölte a demo event ordereit, order line-jait és ledger soraiba (`order_payments`). Ha ezután késve vagy duplán érkezett egy `payment.succeeded`, az order már nem létezett, a saga `unknown_order` refundot adott, és a kötelezettség egyetlen nyoma egy outbox sor maradt. A vevő számára: a pénze nyomot hagy nélkül mozoghat. A rendszer oldalán: a reset ne rombolja le a pénzügyi előzményeket.

## Döntés

1. **A reset felszabadít, de nem töröl pénzügyi előzményt.** A `resetEvent` (`packages/booking/src/booking-service.ts`) minden demo széket `AVAILABLE`-re állít (`holdId`, `claimBuyerKey` törölve), és csak azokat a holdokat törli, amelyekből nem lett order. Az orderek, a soraik, a ledger sorok és a hozzájuk tartozó hold érintetlenek maradnak. A `ResetResult` ezért `ordersKept`-et ad `ordersDeleted` és `ledgerRowsDeleted` helyett.
2. **A székek felszabadítása elég az újraeladáshoz.** A vevőnkénti limit a `claimBuyerKey`-t számolja, nem az order line-okat. A megmaradt line-ok csak történelem: élő ellenőrzés nem olvassa őket, a saga pedig csak `PENDING_PAYMENT` orderhez zárol székeket, és ilyen order a reset után nem marad.
3. **Továbbra is elutasít, ha valakinek tartozunk.** `RESET_BLOCKED`, és semmi nem változik, ha van `PENDING_PAYMENT` order vagy nyitott refund obligation (`REFUND_REQUESTED`, `MANUAL_REVIEW`). A lock sorrend (holds, orders, seats, mind `ORDER BY id FOR UPDATE`) nem változott.

Következmény: egy késői `payment.succeeded` egy korábban `EXPIRED` orderre megtalálja az ordert, és a saga szokásos szabálya érvényes. Ez `REFUND_REQUESTED` ledger sor, a székekhez nem nyúl. Az `unknown_order` ág biztonsági hálóként marad, csak a kommentek és a docs változtak.

## Alternatívák

| Alternatíva                              | Előny                            | Hátrány                                                 | Miért nem itt                                                 |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Mindent törölni (a korábbi viselkedés)   | Egyszerű, tiszta demo            | Késői fizetés ismeretlen orderre fut, nincs ledger      | Pénzügyi előzményt nem szabad eldobni                         |
| Archive táblák a törölt orderekhez       | Tiszta aktív tábla, van előzmény | Sémaváltozás, új mozgó rész, a sagának is ismernie kell | A ticket kizárja: MVP, nincs séma- vagy workflow-változás     |
| Soft delete (`deletedAt` flag)           | Nyom marad                       | Minden lekérdezésnek szűrnie kell, séma változik        | Felesleges: a kept order maga a nyom, a székek amúgy szabadok |
| Reset akkor is, ha `PENDING_PAYMENT` van | Mindig működik                   | A vevő fizethet egy már felszabadított székre           | A vevőnek még tartozunk egy eredménnyel                       |

## Fogalmak

- **Ledger (`order_payments`)**: orderenként a fizetések és dispositionjeik (`REFUND_REQUESTED`, `REFUNDED`...). A reconciler ezt olvassa, ezért kell megmaradnia.
- **Idempotency / redelivery**: ugyanaz az üzenet többször is jöhet. Ha az order és a ledger megvan, az ismert `paymentId` újra no-op.
- **Fail closed**: kétség esetén elutasítunk (`RESET_BLOCKED`), és nem változtatunk semmit.
- **Szeparáció**: a székek állapota a `seats` táblában él (ADR 0005), nem az order line-okban, ezért a line-ok megmaradhatnak.

## Mi romolhat el

| Hiba                                              | Teszt                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Order, line vagy ledger sor törlődik vagy módosul | `reset-event.test.ts`: `demoHistory` előtte/utána `toEqual`, csak az order nélküli hold törlődik |
| A régi claim a limitbe számít, vagy szék beragad  | "after a reset the per-buyer limit counts nothing..." és `dirtyDemoSeats` = 0                    |
| Elutasított reset mégis változtat                 | `demoState` (holds, seats, history) azonos a `PENDING_PAYMENT` és a refund esetekben             |
| Késői capture elveszi az új vevő székét           | "a payment.succeeded for an order that was EXPIRED before the reset..." (szék marad az újé)      |
| Reset deadlockol a saga-val vagy a sweeperrel     | a `racing bookings` blokk valódi Postgresen                                                      |

## Interjúkérdések

1. **Miért nem töröl a reset ordert?** A késői fizetés ordert keres. Ha nincs, csak egy outbox sor jelzi a refundot, amit a reconciler nem lát. Megtartva a saga a normál szabályt alkalmazza.
2. **Ha a line-ok szabad székekre mutatnak, nem hibás ez?** Nem, mert a székek igazsága a `seats` tábla (ADR 0005). A line csak történelem, a limit pedig `claimBuyerKey`-t számol.
3. **Miért marad a `PENDING_PAYMENT` blokk?** Az a vevő még fizethet. Ha felszabadítanánk a székét, két vevő kapna ugyanarra jogot. A blokk fail closed, és a teszt bizonyítja, hogy semmi nem változik.
4. **Mi lett az `unknown_order` ággal?** Marad biztonsági hálónak olyan orderre, ami sosem létezett ebben az adatbázisban. A reset már nem okoz ilyet. (Ez a döntés a `.devflow/questions.md`-ben még nyitott, feltételezett válasz.)
5. **Miért nem archive tábla?** Séma- és workflow-változást hozna egy demo funkcióért. A ticket MVP-scope-ja kizárja.
