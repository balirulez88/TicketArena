# 23: Refund reconciler és manual review

Ticket: `issues/23-refund-reconciler.md`, commit: még nincs (a változtatás staged), ADR: 0003 (transactional outbox), 0006 (booking saga és payment ledger).

## Probléma

Ha a `payment.refund_requested` üzenetre nem jön válasz (a Payment service kiesett, az üzenet elveszett), a refund obligation örökre `REFUND_REQUESTED` marad: az ügyfél pénze nála ragad, és senki nem veszi észre. A rendszernek magától újra kell kérnie a refundot, és ha ez sem segít, emberhez kell fordulnia.

## Döntés

1. **Reconciler pass** (`packages/booking/src/refund-reconciler.ts`, `reconcileRefunds`): a worker 5 percenként lefuttatja. Minden olyan sor, amelynek utolsó kérése legalább 10 perces (`refundLastRequestedAt`), új `payment.refund_requested` outbox sort kap, és a `refundAttempts` nő. Ha a számláló már 3, a sor `MANUAL_REVIEW` lesz, és nem megy ki több kérés. Ugyanez igaz a ledger sorokra és a ticket 70 `orphan_refund_obligations` soraira: egy `sources` objektum mögött ugyanaz a logika fut mindkét táblán.
2. **Helyesség**: a kérés (outbox sor) és a számláló növelése **egy tranzakcióban** commitol (ADR 0003), így nincs elveszett vagy számolatlan re-emit. A kiválasztás `FOR UPDATE SKIP LOCKED`, ezért két párhuzamos worker szétosztja a sorokat, nem emitál duplán, és nem vár egymásra. Csak az obligation sort zárja, az orderét nem, így nem fordíthatja meg a saga lock sorrendjét.
3. **`retryRefund`**: az operátor `MANUAL_REVIEW` sort visszateszi `REFUND_REQUESTED` állapotba, újra emitál, és a számlálót nullázza (újra megkapja a teljes budgetet). Más állapotra `RefundNotInManualReviewError`, ismeretlen payment-re `RefundObligationNotFoundError`.
4. **Adat**: a migráció (`20261128000000_refund_reconciler`) oszlopokat vesz fel (`refundReason`, `refundLastRequestedAt`, orphan-nál `correlationId`), mert eddig a kérés tartalma csak az outbox sorban élt, amit a retention töröl. `CHECK` constraint és részleges index (csak nyitott sorokra) tartozik hozzá. A `refundPendingAgeMax` a legrégebbi nyitott obligation első kérésétől mért kor (negatív sosem).

## Alternatívák

| Alternatíva                                   | Előny               | Hátrány                                                           | Miért nem itt                                            |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Végtelen automatikus retry                    | Nincs emberi teendő | Tartósan hibás sor örökké terheli a rendszert, senki nem tud róla | A 3 re-emit után az operátor látja (warn log, dashboard) |
| Az outbox sorok újrajátszása a ledger helyett | Nincs új oszlop     | Az outbox retention törli a sort, az orphan eset nyomtalan lenne  | A kérés a ledgerből újraépíthető                         |
| Csak egy `SELECT` + külön `UPDATE` zár nélkül | Egyszerűbb          | Két worker ugyanazt a sort duplán emitálja                        | `SKIP LOCKED` (általános minta, itt teszttel igazolt)    |
| Redis alapú ütemezés                          | Gyors               | A refund állapotot nem döntheti el a Redis (CLAUDE.md szabály)    | Postgres az igazság forrása                              |

## Fogalmak

- **Reconciler**: periodikus folyamat, amely az elvárt és a tényleges állapotot összeveti, és javít.
- **Outbox**: az esemény ugyanabban a tranzakcióban kerül az adatbázisba, mint az állapotváltozás, egy külön publisher küldi ki.
- **Idempotency**: ugyanazt az üzenetet többször feldolgozva ugyanaz az eredmény. Itt azért biztonságos az újraküldés, mert a Payment oldali refund `payment.refunds` PK-n deduplikál (ticket 20).
- **`SKIP LOCKED`**: a zárolt sorokat átugorja ahelyett, hogy várna rájuk.
- **`MANUAL_REVIEW`**: végállapot-szerű parkolás, amelyből csak operátor hozza vissza.

## Mi romolhat el

- Fiatal obligation re-emitje, vagy a 10 perces időköz csúszása: a "left alone while younger than 10 minutes" és "ages each re-emit from the previous request" tesztek (`refund-reconciler.test.ts`).
- Két párhuzamos pass dupla emitje: "re-emitted once when two reconciler passes run at the same time".
- Végtelen retry: "moves to MANUAL_REVIEW, emitting nothing, once its third re-emit is 10 minutes old".
- Már kifizetett (`REFUNDED`) vagy `MANUAL_REVIEW`-ban megkapott `payment.refunded` sor újraemitje: "that is REFUNDED is never re-emitted", "in MANUAL_REVIEW is still closed by payment.refunded".
- Hibás retry: "refuses an obligation that is not in MANUAL_REVIEW and changes nothing" és "is NOT_FOUND ...".
- Végponttól végpontig: AT-24 teszt; a dashboard metrika: `refund-pending-age.test.ts`; a migráció backfillje: `packages/db/src/refund-reconciler-migration.test.ts`.

## Interjúkérdések

1. **Miért kell a re-emit és a számláló növelése egy tranzakcióban?** Ha külön commitolnának, egy összeomlás után vagy kiküldetlen, de számolt, vagy kiküldött, de számolatlan kérés maradna. Az outbox minta ezt zárja ki (ADR 0003).
2. **Mi történik, ha két worker egyszerre fut?** A `FOR UPDATE SKIP LOCKED` miatt szétosztják a sorokat. Ha az egyik commitolt, a sor `refundLastRequestedAt`-je már friss, így a másik nem találja stale-nek.
3. **Miért nem veszélyes az újraküldés?** A fogyasztó idempotens: a Payment `payment.refunds` PK + `ON CONFLICT DO NOTHING` miatt egy refund csak egyszer fut le, a többi kérés no-op.
4. **Miért van szükség új oszlopokra a ledgeren?** A kérés tartalma (reason, correlation id) addig csak az outbox sorban élt, amit a retention töröl. A reconcilernek a tartós táblából kell tudnia újraépíteni a kérést.
5. **Miért nullázza a `retryRefund` a számlálót?** Az operátor beavatkozása új kezdet: a reconciler újra megkapja a teljes 3 re-emit budgetet, különben az első stale pass azonnal visszaparkolná.
