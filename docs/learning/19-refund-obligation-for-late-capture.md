# 19: Refund obligation késői capture esetén

Ticket: `issues/19-refund-obligation-for-late-capture.md`. ADR: 0006 (saga), 0007 (consumer dedupe). Spec: Payment saga, Refund obligations.

## Probléma

A vásárló a határidő (`paymentDeadline`) után fizet: a Payment szolgáltatás már levonta a pénzt, de a rendelés lejárt vagy lejárhat, a székek másé lehetnek. A rendszer oldaláról a pénzt nem tarthatjuk meg és a rendelést sem erősíthetjük meg. Ugyanez igaz, ha a rendelés már `EXPIRED`/`CANCELLED`/`CONFIRMED`, az összeg nem stimmel, vagy a rendelés már nem is létezik (demo reset törölte). Minden levont pénzhez tartós visszatérítési kötelezettség kell, és soha nem szabad elveszni.

## Döntés

1. **Refund obligation = ledger sor + outbox esemény, ugyanabban a tranzakcióban.** A `payment-saga.ts` `insertRefundObligation` egy `REFUND_REQUESTED` sort ír az `order_payments` táblába (`refundRequestedAt = T`), az `emitRefundRequested` pedig `payment.refund_requested` outbox eseményt (contacttal). Ha bármelyik hibázik, minden rollbackel (teszt: "rolls the late-capture expiry back...").
2. **Késői capture = lejáratás, nem seat-visszaszerzés.** `PENDING_PAYMENT` + `capturedAt > paymentDeadline` esetén az `expireForLateCapture` egy tranzakcióban: order `EXPIRED` (feltételes update, nulla érintett sor = hiba), a `IN_CHECKOUT` székek `AVAILABLE`, `order.expired`, refund obligation. A székeket akkor sem foglaljuk újra, ha szabadok (AT-20). A `decide()` tiszta függvény marad, a handler csak alkalmazza.
3. **Ismeretlen `orderId`: refund, nem poison.** Nincs order, így ledger sor sem (FK az `orders`-re). Az outbox sor maga a kötelezettség. Mivel nincs order sor, amit zárolni lehetne, a handler `pg_advisory_xact_lock`-ot vesz a `refund:<paymentId>` kulcsra, és csak akkor ír eseményt, ha még nincs ilyen `paymentId`-ra. Így redelivery és új message id-s duplikátum is pontosan egy refundot ad. Ismeretlen `paymentId` egy `refunded` eseményen továbbra is poison.

A `+late@` email a mock Payment kézbesítést nem késlelteti: `capturedAt = paymentDeadline + 1 s` (provider idő), azonnal küldi.

## Alternatívák

| Alternatíva                                        | Előny                        | Hátrány                                                                      | Miért nem itt                              |
| -------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Késői fizetés megerősítése, ha a szék még szabad   | Nincs refund, a vásárló örül | Szék-állapot függ az időzítéstől, versenyhelyzet a sweeperrel, a spec tiltja | AT-20 kifejezetten megtiltja               |
| Csak outbox esemény, ledger sor nélkül (mindenhol) | Egyszerűbb                   | A reconciler a ledger sorokat scanneli, nincs újrapróbálás                   | Csak ismeretlen ordernél kényszer          |
| Ismeretlen order `poison` marad (DLQ)              | Nincs új kód                 | Levont pénz marad nyomtalanul, a retry ütemezés pörög                        | Pénzt soha nem tartunk meg csendben        |
| Egyedi index a refund eseményen duplikátum ellen   | Nincs advisory lock          | Az outbox tábla általános, a `paymentId` a JSON-ban van                      | Advisory lock olcsóbb séma-változás nélkül |

## Fogalmak

- **Outbox**: az eseményt az üzleti adattal egy tranzakcióban írjuk egy táblába, egy relay publikálja később. Így nincs "DB commit megvolt, de az üzenet elveszett".
- **Refund obligation**: tartós rekord arról, hogy pénzt vissza kell adni; újrapróbálható, amíg `REFUNDED` nem lesz.
- **Saga**: több szolgáltatáson átívelő folyamat, lépésenként tranzakcióval és kompenzációval (itt a refund).
- **Idempotency / dedupe**: ugyanaz az üzenet többszöri feldolgozása ugyanazt az eredményt adja. A `processed_messages` message id alapján véd, de a duplikátum új id-t kap, ezért kell `paymentId` szintű védelem is.
- **Advisory lock**: alkalmazás által választott kulcsra vett Postgres zár, tranzakció végén szabadul. Ott használható, ahol nincs zárolható sor.
- **Provider time**: a "időben" döntést a capture időbélyege adja, nem a kézbesítés ideje.

## Mi romolhat el

- Részleges commit (order lejár, de nincs refund): rollback teszt `payment-saga.test.ts`.
- Szék újrafoglalása késői fizetésre: AT-20 `late-capture-flow.test.ts` (end-to-end, a szék `AVAILABLE`, nincs `order.confirmed`) és a `EXPIRED` order-es `test.each` teszt.
- Dupla refund ismeretlen ordernél: redelivery + duplikátum teszt, valamint a két párhuzamos duplikátum versenye (az egyik tranzakció nyitva marad, a másik `pg_stat_activity`-ben vár a zárra).
- Crash commit és ack között: `late-capture-flow.test.ts` eldobja az első ackot, a broker újrakézbesít, mégis egy kérés lesz.
- Ugyanaz a payment kétszer egy lezárt orderre: a ledger `paymentId` PK és a `decide` "known payment = noop" miatt egy sor (teszt: "same payment reaches a settled order twice").

## Interjúkérdések

1. **Miért ledger sor és outbox esemény is?** A ledger sor a tartós állapot, amit a reconciler újra tud emittálni; az outbox esemény értesíti a többi szolgáltatást. Egy tranzakcióban vannak, így nem lehet az egyik a másik nélkül.
2. **Miért nem erősítjük meg a késői fizetést, ha a szék szabad?** A döntés így az időzítéstől és a sweepertől függene, nem determinisztikus. A szabály egyszerű: a határidő utáni capture refund (AT-20).
3. **Hogyan lesz pontosan egy refund ismeretlen ordernél?** Advisory lock a `paymentId`-n sorosít, majd az outboxban keresünk korábbi kérést. A `processed_messages` itt nem elég, mert a duplikátum új message id-t kap.
4. **Mi a gyenge pont az ismeretlen order megoldásban?** Nincs ledger sor, a reconciler nem látja, ezért az outbox sor az egyetlen nyoma. A kód a retention-re támaszkodik (az outbox sor túléli a stream-et); ezt a spec és a dokumentáció rögzíti.
5. **Miért marad poison az ismeretlen order egy `failed` eseményen?** Ott nincs levont pénz, tehát nincs mit visszaadni; a rossz üzenet hibajelzés, nem pénzügyi kockázat.
