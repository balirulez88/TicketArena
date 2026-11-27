# 36: Admin live feed, üzenet-egészség és beragadt refundok

Ticket: `issues/36-admin-feed-message-health-and-refunds.md`. Commit: még nincs (munkafában). ADR: [0009](../adr/0009-per-service-schemas.md), [0011](../adr/0011-delivery-retry-dlq-recovery.md), [0022](../adr/0022-terminal-failed-outbox-events.md).

## Probléma

Az admin dashboard eddig csak a foglalási képet mutatta (seatek, orderek, sor, számlálók). Nem látszott, hogy egy booking sagája hol tart a szolgáltatások között, hogy a kézbesítés akad-e (consumer lag, nyugtázatlan üzenetek, DLQ), és hogy melyik vevő pénze vár még visszatérítésre. A ticket 23 reconcilere `MANUAL_REVIEW`-ba teszi a feladott refundot, de nem volt gomb, amivel operátor újrapróbálhatta volna.

## Döntés

1. **Live feed az outboxok uniójából** (`admin.feed`, `apps/web/src/server/admin/outbox-feed.ts`). ADR 0009 szerint minden integrációs esemény outbox sorként indul, így a három outbox együtt az eseménynapló. Cursor: `(createdAt, id)`; kurzor nélkül a legújabb `limit` bejegyzés, kurzorral csak ami utána jön. Minden ágnak saját `(createdAt, id)` indexe van (új migráció), így egy poll egy indexelt lap, akármilyen hosszú a napló. A bejegyzés metaadat és `status` (`FAILED` is), payload soha: abban a vevő e-mail címe és telefonszáma van.
2. **NATS számok a worker `/health`-ből.** A JetStream adapter `deliveryHealth(consumers, now)`-t ad (`DeliveryHealthProbe`): consumerenként `num_pending`, `num_ack_pending`, `num_redelivered`, a DLQ streamre üzenetszám és a legrégebbi üzenet kora. A `/health` új, opcionális `delivery` mezőben adja ki; a meglévő mezők és a `status: "ok"` nem változnak (a ticket 59 mintája). A web app `WORKER_HEALTH_URL`-ről olvassa, 800 ms timeouttal és zod validálással; ha nincs beállítva vagy nem elérhető, a mező `null`, a snapshot többi része megy tovább.
3. **Outbox lag a Postgresből**, szolgáltatásonként, a snapshotban; a spec szerint csak a NATS számok jönnek a workertől.
4. **Stuck refunds és retry.** `BookingService.openRefunds(limit)` a ledger és az orphan obligationök nyitott sorait adja, a legrégebbi első kéréstől, `ageMs`-sel. Az `admin.retryRefund` a meglévő `retryRefund`-ot hívja; `NOT_FOUND` és `PRECONDITION_FAILED` (`REFUND_NOT_IN_MANUAL_REVIEW` domain kód), mindkettő megnevezi a payment id-t.
5. **Számlálók**: a reader most a `deadlock_retry`-t és a saga `late_delivery_refund`-ját is olvassa.

## Alternatívák

| Alternatíva                                  | Előny                         | Hátrány                                                       | Miért nem itt                                 |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Külön feed tábla vagy NATS-ről olvasott feed | Pontos sorrend commit szerint | Új írási út, vagy a web app NATS kliense                      | ADR 0009: az outbox már az eseménynapló       |
| OFFSET alapú lapozás                         | Egyszerű                      | Nagy offsetnél lassú, új sorok elcsúsztatják a lapokat        | A `(createdAt, id)` cursor stabil és indexelt |
| A web app közvetlenül kérdezi a NATS-t       | Nincs worker függés           | A Next.js bundle-be NATS kliens kerül, ADR 0004 egy adapter   | A spec a worker health endpointját nevezi meg |
| Payload a feedben                            | Több részlet                  | Vevői elérhetőség a böngészőben                               | A dashboardnak a "mi és mikor" elég           |
| Retry minden nyitott refundra                | Egy gomb mindenre             | A `REFUND_REQUESTED`-et a reconciler már magától újrapróbálja | A ticket 23 döntése: csak `MANUAL_REVIEW`-ból |

## Fogalmak

- **Keyset (cursor) lapozás**: a következő lap az utolsó látott kulcs után kezdődik (`(createdAt, id) > cursor`), nem egy sorszám után.
- **Consumer lag (`num_pending`)**: a consumer szűrőjére illő, még ki nem kézbesített üzenetek száma.
- **Pending ack (`num_ack_pending`)**: kézbesített, de még nem nyugtázott üzenetek.
- **Redelivery (`num_redelivered`)**: a nyugtázatlanok közül a többször kézbesítettek; pillanatnyi szám, nem összesítő.
- **Liveness vs. riasztás**: a `/health` `status: "ok"` csak azt mondja, hogy a worker él; a lag és a DLQ az operátornak szóló jel, nem újraindítási ok.

## Mi romolhat el

| Hiba                                                        | Teszt                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A feed rossz sorrendben, vagy egy outboxot kihagy           | `admin-feed.test.ts`: "without a cursor is the newest entries of every outbox…"                      |
| A cursor utáni lap ismétel vagy kihagy (azonos `createdAt`) | ugyanott: "after a cursor is only what follows it by (createdAt, id)…"                               |
| A payload (vevői adat) kijut a böngészőbe                   | ugyanott: a bejegyzések pontos alakja (`toEqual`), payload nélkül                                    |
| Hibás broker számok                                         | `packages/messaging/src/delivery-health.test.ts`: valódi NATS, lag, pending ack, redelivery, DLQ kor |
| A `/health` elrontja a liveness-t                           | `apps/worker/src/delivery-health.test.ts`: "unavailable" mellett is 200 és `status: "ok"`            |
| Elérhetetlen worker eldönti a snapshotot                    | `admin-message-health.test.ts`: 503, hibás törzs, beállítatlan URL mind `delivery: null`             |
| Lezárt refund a listán, rossz kor, retry nem a meglévő úton | `admin-refunds.test.ts`: lista, kor, retry outbox sorral, `NOT_FOUND` és `PRECONDITION_FAILED`       |

## Interjúkérdések

1. **Miért az outboxok uniója a feed?** Mert minden integrációs esemény outbox sorként jön létre ugyanabban a tranzakcióban, mint az állapotváltozás; nincs második napló, ami eltérhetne.
2. **Mi a cursor korlátja?** A `createdAt` a tranzakció kezdete, így egy korábban bélyegzett, de később commitolt sor kimaradhat a már továbblépett pollból. A feed embereknek szóló nézet; a kézbesítési garanciát az outbox és a relay adja.
3. **Miért a worker adja a NATS számokat?** A web app így nem függ a NATS klienstől, és a broker csak a worker privát hálózatán érhető el. Ennek ára, hogy a jelenlegi topológiában (privát worker) a számok "unavailable"-ök.
4. **Miért csak `MANUAL_REVIEW`-ból lehet retry?** A `REFUND_REQUESTED`-et a reconciler 10 percenként magától újrakéri; a kézi retry csak ott kell, ahol a gép feladta.
5. **Hogyan marad kompatibilis a `/health`?** Csak új, opcionális mezőt kap; a meglévő mezők és a 200 / `status: "ok"` változatlanok.
