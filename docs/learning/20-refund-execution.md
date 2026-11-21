# 20: Refund execution a Payment szolgáltatásban

Ticket: `issues/20-refund-execution.md`. ADR: 0003 (outbox), 0006 (saga ledger), 0007 (consumer dedupe), 0009 (per-service schemas). Spec: Refund obligations, Mock Payment service.

## Probléma

A 19-es ticket után a késői capture-ből `REFUND_REQUESTED` ledger sor és `payment.refund_requested` esemény lett, de senki nem fogyasztotta el: a pénz ténylegesen nem ment vissza. A Payment szolgáltatásnak végre kell hajtania a visszatérítést, és pontosan egyszer, akkor is, ha a kérés duplikálódik. A booking oldalnak ezután le kell zárnia a ledger sort (`REFUNDED`).

## Döntés

1. **A `paymentId` elsődleges kulcs az egyszeri végrehajtás záloga.** A `refund-handler.ts` a `payment.refunds` táblába `createMany({ skipDuplicates: true })` (`ON CONFLICT DO NOTHING`) szúr be, és csak akkor emit `payment.refunded` eseményt, ha a beszúrás tényleg írt sort. A `processed_messages` az újrakézbesítést fogja meg, de a duplikált kérés új event id-t kap, ezt a PK fogja meg. Párhuzamos duplikátumnál a második insert megvárja az első commitálatlan sorát, majd kihagyja (AT-23, `refund-handler.test.ts`).
2. **Sor, dedupe sor és esemény egy tranzakcióban, a Payment saját outboxán át.** A handler `service: "payment"` runnerhez kötött, így nincs "refund megtörtént, de az esemény elveszett". A `payment.refunded` viszi a request `contact` mezőjét, hogy a Notification ne olvassa a booking tábláit (ADR 0009). Az `unknown_order` kérésnek nincs contactja, a refund ettől még lefut.
3. **A booking saga zárja a ledgert feltételes update-tel.** A `decide()` `refund_completed` átmenetet ad, a `recordRefunded` pedig `updateMany`-vel `REFUND_REQUESTED`/`MANUAL_REVIEW` → `REFUNDED`-re vált; ha nem pontosan egy sor változik, hibát dob (a döntés elavult). Két mátrix-rés is megoldódott: az amount-mismatch refund a rendelést `PENDING_PAYMENT`-ben hagyja, ezért a ledger sor számít, nem a rendelés státusza; és ha a rendelés már nem létezik, a saga a booking outboxában keresi a kérést (`unknown_order_refunded` noop, különben poison).

## Alternatívák

| Alternatíva                                  | Előny                 | Hátrány                                                       | Miért nem itt                                    |
| -------------------------------------------- | --------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Előbb `SELECT`, aztán `INSERT`               | Olvasható             | Két párhuzamos tranzakció is "nem látja" a sort, dupla refund | Az `ON CONFLICT` atomi, nincs check-then-act     |
| Csak `processed_messages` dedupe             | Nincs új tábla        | Az új event id-s duplikátumot nem fogja meg                   | A reconciler vagy egy kétszer írt kérés ilyet ad |
| Advisory lock `paymentId`-ra (mint a 19-ben) | Sor nélkül is működik | Extra zár, bonyolultabb                                       | Itt van természetes egyedi kulcs: a `refunds` PK |
| Duplikátumnál is újra emit                   | Egyszerű recovery     | Dupla `payment.refunded`, dupla értesítés                     | A spec: duplikátum nem emittál                   |

## Fogalmak

- **Idempotency**: ugyanaz a kérés többszöri feldolgozása ugyanazt az állapotot adja. Itt két rétegben: message id (`processed_messages`) és üzleti kulcs (`paymentId`).
- **Outbox**: az eseményt az üzleti adattal egy tranzakcióban írjuk egy táblába, a relay publikálja később (ADR 0003).
- **`ON CONFLICT DO NOTHING`**: Postgres-szintű "ha már van ilyen kulcs, hagyd ki". Párhuzamos insertnél a második megvárja az első commitját.
- **Conditional update (optimistic guard)**: az `UPDATE ... WHERE disposition IN (...)` csak a várt állapotból lép; nulla érintett sor jelzi, hogy a döntés elavult.
- **Poison message**: olyan üzenet, amit újrapróbálás sem tud feldolgozni, ezért DLQ-ba kerül.

## Mi romolhat el

- Duplikált kérés új event id-vel: egy sor, egy esemény (AT-23, `refund-handler.test.ts`, "duplicate ... under a new event id").
- Két párhuzamos duplikátum: az egyik tranzakció nyitva marad, a másik `pg_stat_activity`-ben a zárra vár; a végén egy sor és egy esemény ("two duplicates that race").
- Érvénytelen payload: semmi nem íródik (teszt: "rejects a request whose payload is invalid").
- Ledger lezárása: `REFUND_REQUESTED` és `MANUAL_REVIEW` is `REFUNDED` lesz, ismételt esemény noop, ismeretlen `paymentId` poison (`payment-saga.test.ts`, `payment.refunded` blokk).
- Amount-mismatch refund `PENDING_PAYMENT` rendelésen: nem poison (`saga-decision.test.ts`, `payment-saga.test.ts`).
- Teljes lánc: `refund-flow.test.ts` a késői fizetéstől a `REFUNDED` ledger sorig, valódi workerrel.

## Interjúkérdések

1. **Hogyan lesz pontosan egy refund?** A `payment.refunds` PK-ja `paymentId`, a handler `ON CONFLICT DO NOTHING`-gal szúr be, és csak akkor emit, ha írt sort. A `processed_messages` önmagában nem elég, mert a duplikátum új event id-t kap.
2. **Miért nem SELECT-then-INSERT?** Két párhuzamos tranzakció egyszerre láthatja üres táblának, és mindkettő beszúrna. Az adatbázis egyedi kulcsa atomi, a versenyt a második insert blokkolása oldja meg.
3. **Miért a Payment outboxába ír a handler?** Ha a sor és az esemény külön commitolna, crash esetén refund lenne esemény nélkül. Egy tranzakcióban vagy mindkettő megvan, vagy egyik sem.
4. **Mi történik, ha a rendelés közben törlődött?** Nincs ledger sor, ezért a saga a booking outboxában keresi a `refund_requested` eseményt: ha megvan, logolt noop, ha nincs, poison. Ez a 19-es ticketben bevezetett outbox-mint-kötelezettség folytatása.
5. **Mi a gyenge pont duplikátumnál?** Egy újra-emittált kérés már végrehajtott refundra nem ad második `payment.refunded`-et, így a recovery az első eseményre támaszkodik a Payment outboxában. Ezt a ticket a kérdéslistában rögzítette, a reconciler még nincs kész.
