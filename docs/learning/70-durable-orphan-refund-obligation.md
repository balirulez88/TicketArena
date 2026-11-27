# 70: Tartós refund obligation ismeretlen orderhez

Ticket: `issues/70-durable-orphan-refund-obligation.md`, commit: még nincs (a változtatás staged), ADR: 0006 (booking saga és payment ledger), 0003 (transactional outbox).

## Probléma

A Payment service pénzt vont le egy `orderId`-re, de a booking adatbázisában nincs ilyen order (`unknown_order`). A pénzt vissza kell adni, de a ledger (`order_payments`) sorához order kell, így az egyetlen nyoma a `payment.refund_requested` outbox sor volt. A tervezett 14 napos outbox retention ezt törölné, miközben a refund még nyitott lehet, és a (későbbi) reconciler, amely a ledgert nézi, sosem látná.

## Döntés

Új tábla: `orphan_refund_obligations` (`packages/db/prisma/schema.prisma`). A kulcsa a `paymentId` (PK), az `orderId`-re nincs foreign key, és tartalmaz mindent a kérés újraküldéséhez (amount, currency, `capturedAt`, `status`, `refundRequestedAt`).

A kulcsötlet: **a PK a dedupe**. A saga (`payment-saga.ts`, `requestUnknownOrderRefund`) `createMany` + `skipDuplicates` (azaz `INSERT … ON CONFLICT DO NOTHING`) hívással szúr be, és csak akkor emittálja a `payment.refund_requested` eseményt, ha ez a tranzakció írta a sort. Egy párhuzamos duplikátum insertje megvárja a még nem commitolt sort, majd kihagyja, így pontosan egy obligation és egy outbox sor lesz. Ez kiváltja a korábbi advisory lockot és az outbox-olvasást.

A másik fele: `payment.refunded` ismeretlen orderre `FOR UPDATE` zárral olvassa az obligationt, és a tiszta `decide()` (`saga-decision.ts`) dönt: `REFUND_REQUESTED` esetén `transition` (`orphan_refund_completed`, feltételes update `REFUNDED`-re), `REFUNDED` esetén `noop` (`already_refunded`), obligation nélkül `poison`. Az outboxot a döntés már nem nézi.

A migráció visszatölti (backfill) a meglévő `unknown_order` outbox sorokat nyitott obligationként, `paymentId`-nként a legkorábbi kérésből. A `capturedAt` az `occurredAt`, mert a kérés nem hordoz capture időt.

## Alternatívák

| Alternatíva                                           | Előny                     | Hátrány                                                              | Miért nem itt                                              |
| ----------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Marad az outbox sor mint obligation                   | Nincs új tábla            | A retention törli, a reconciler nem látja                            | Pont ez a hiba                                             |
| Az outbox sorokat kivenni a retention alól            | Kis változás              | Az outbox kézbesítési napló, nem állapottár; keveri a felelősségeket | Az obligationnek állapota van (`REFUNDED`)                 |
| Ledger sor `orderId` nélkül (nullable FK)             | Egy tábla a reconcilernek | Meglazítja a ledger invariánsát, minden meglévő lekérdezést érint    | A saját tábla szűkebb és biztonságosabb (a ticket döntése) |
| Advisory lock + létezés-ellenőrzés (korábbi megoldás) | Nem kell tábla            | Az ellenőrzés az outboxra épül, ami törlődik                         | Nem tartós                                                 |

## Fogalmak

- **Refund obligation**: a rendszer tartozik egy visszatérítéssel; addig nyitott, amíg `payment.refunded` le nem zárja.
- **Transactional outbox**: az eseményt az üzleti adattal egy tranzakcióban írjuk, külön folyamat publikálja (ADR 0003). Kézbesítési eszköz, nem hosszú életű rekord.
- **Idempotency**: ugyanaz az üzenet kétszer sem hat kétszer. Itt nem elég a `processed_messages`, mert egy duplikált capture új message id-t kap; a `paymentId` PK-ja kell.
- **`ON CONFLICT DO NOTHING`**: ütközésnél nem hibázik, de a hívó látja, hogy nem írt (`count === 0`).
- **Poison**: olyan üzenet, amit soha nem lehet feldolgozni; DLQ-ba kerül, nem retry-ol.
- **Backfill**: a migráció a régi adatból tölti fel az új táblát.

## Mi romolhat el

- Dupla vagy párhuzamos capture: egy obligation, egy outbox sor. Tesztek: "requests one refund … however often its payment is delivered" és "… when two duplicates race" (`payment-saga.test.ts`).
- Outbox írás hibázik: az obligation sem marad meg (ugyanaz a tranzakció). Teszt: "writes neither the orphan obligation nor its refund request when the outbox write fails".
- Retention törli az outbox sort: az obligation olvasható és újraépíthető belőle a kérés; a `payment.refunded` is lezárja. Tesztek: "keeps the open orphan obligation … when its outbox row is deleted", "closes the orphan obligation even after its outbox row is gone".
- Ismételt `payment.refunded`: nem változik semmi. Teszt: "acks a repeated payment.refunded …".
- Sem ledger, sem obligation: `poison`. Teszt: "… exists only in the outbox".
- Meglévő éles sorok elvesznek: `orphan-refund-backfill-migration.test.ts` (két kérés ugyanarra a fizetésre egy sort ad, más okú kérést nem visz át, a PK ütközik).

Ismert korlát: a backfillelt obligation akkor is `REFUND_REQUESTED` marad, ha a refund már megtörtént, mert a booking nem látja a Payment sémát. Az újraküldés nem refundál kétszer, mert a `payment.refunds` `paymentId`-n unique (ez a doksi és a migráció kommentje szerint van így).

## Interjúkérdések

1. **Miért nem elég az outbox sor mint a refund nyoma?** Az outbox kézbesítési mechanizmus, retention törli. Egy nyitott pénzügyi tartozásnak olyan helyen kell lennie, ami addig él, amíg a tartozás.
2. **Hogyan lesz egy obligation párhuzamos duplikátumok mellett?** A `paymentId` PK és `ON CONFLICT DO NOTHING`. A második insert megvárja az első commitját, majd nem ír, és mivel nem írt, nem is emittál.
3. **Miért nincs foreign key az `orderId`-n?** Az order nem létezik, ez az eset definíciója. Az FK lehetetlenné tenné a sort.
4. **Miért tiszta függvény a `decide()`?** A saga összegyűjti a zárolt bemenetet (`lockSagaInputs`), a `decide()` csak táblázatot értékel, így a mátrix I/O nélkül tesztelhető (`saga-decision.test.ts`).
5. **Mi a kockázata a backfillnek?** `capturedAt` közelítés (`occurredAt`), és a már lezárt refund nyitottnak látszik. Az idempotens Payment oldal miatt ez nem okoz dupla refundot.
