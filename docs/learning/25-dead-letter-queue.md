# 25: Dead-letter queue routing

Ticket: `issues/25-dead-letter-queue.md`. Commit: még nincs (munkafában). ADR: [0011](../adr/0011-delivery-retry-dlq-recovery.md), [0022](../adr/0022-terminal-failed-outbox-events.md) (táblázat módosítva).

## Probléma

Egy üzenet, amelyet a handler soha nem tud feldolgozni (hibás séma, ismeretlen verzió, `poison` kimenet, vagy kimerült retry keret), eddig örökké újrakézbesítődött, mert ADR 0011 szerint DLQ-másolat nélkül tilos `term`-ölni. A felhasználó oldalán ez beragadt feldolgozást és felesleges terhelést jelent; a rendszer oldalán senki nem látta a méreg-üzenetet.

## Döntés

1. **A kapu a handler előtt fut** (`consumer-runner.ts`, `gate`). Ha `deliveryCount > 5` (`RETRY_BUDGET`), az üzenet a DLQ-ba megy anélkül, hogy a `beforeTransaction` vagy a handler lefutna. Így az az üzenet is a DLQ-ba kerül, amely minden alkalommal összeomlasztja a folyamatot. A `deliveryCount` a JetStream számlálója, ezért túléli az újraindítást. Ha a runner kap `schemas`-t (verziónként egy `safeParse`-os séma), akkor a nem-JSON, az ismeretlen verziójú és a sémának nem megfelelő üzenet már az első kézbesítéskor a DLQ-ba megy. A worker minden consumere átadja a sémáit (`ENVELOPE_SCHEMAS` a `consumers.ts`-ben).
2. **Publish, PubAck, és csak utána `term`** (`deadLetter`). A DLQ üzenet a `ta.dlq.<consumer>` subjectre megy `Nats-Msg-Id = dlq:<consumer>:<envelope id>` azonosítóval; a törzs a `DeadLetter` (eredeti envelope bájtra pontosan, hiba oka, `deliveryCount`). A kulcs ötlet: az azonosító az envelope id-ből származik, ezért ha a folyamat a PubAck és a `term` között összeomlik, az újrapublikálás a DLQ stream duplikáció-ablakán belül nem hoz létre második másolatot.
3. **Sikertelen DLQ publish → `nak(2 perc)`, soha `term`.** Így nem veszhet el üzenet úgy, hogy nincs róla másolat. A `poison` handler kimenet a rollback után kerül a DLQ-ba (`handler_poison`).

Mellékhatás: a `poison` eddig újrakézbesítést jelentett, most DLQ. Ezért az ADR 0022 táblázata és a `failed-outbox-consumer-flow.test.ts` frissült: a `payment.refunded` a DLQ-ból az operátor replay-ével (a durable újralétrehozásával) érvényesül.

## Alternatívák

| Alternatíva                    | Előny                | Hátrány                                            | Miért nem itt                                              |
| ------------------------------ | -------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Örök retry (az előző állapot)  | Nincs új komponens   | A méreg-üzenet örökké forog, nincs látható hely    | Ezt váltja ki a ticket                                     |
| `term` DLQ nélkül              | Egyszerű             | Az üzenet elveszhet, nincs recovery                | ADR 0011 tiltja                                            |
| In-process próbálkozásszámláló | Nem kell broker adat | Újraindításkor nullázódik, a crash-loop nem számít | A `deliveryCount` mindent számol és túléli az újraindítást |
| `term` előbb, publish utána    | Nincs duplikáció     | Crash esetén az üzenet DLQ-másolat nélkül elvész   | Sérti a "soha nem term DLQ nélkül" szabályt                |
| Véletlen DLQ msg id            | Triviális            | Crash után kétszeres bejegyzés (AT-28 bukna)       | A származtatott id adja az exactly-once hatást             |

## Fogalmak

- **Dead-letter queue (DLQ)**: külön stream a feldolgozhatatlan üzeneteknek, hogy ember megnézhesse és újrajátszhassa.
- **Poison message**: olyan üzenet, amelyet újrapróbálva sem lehet feldolgozni (rossz séma, ismeretlen verzió).
- **`deliveryCount`**: a JetStream számlálója, hányszor kézbesítették az üzenetet; crasht és `AckWait` lejáratot is számol.
- **`Nats-Msg-Id` és duplikáció-ablak**: a broker az azonos id-jú publikálást az ablakon belül eldobja; itt ez adja az idempotenciát.
- **`ack` / `nak` / `term`**: nyugtáz / késleltetve újrakézbesít / végleg lezár.
- **PubAck**: a broker visszaigazolása, hogy a publikált üzenetet tárolta.

## Mi romolhat el

| Hiba                                                          | Teszt                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Kimerült keret után kétszeres DLQ-bejegyzés, vagy handler fut | `consumer-runner-dlq.test.ts`: "dead-letters the 6th delivery without invoking the handler…" (AT-28)               |
| Crash a publish és a `term` között második másolatot ad       | ugyanott: "creates no second DLQ entry when the process crashes between the DLQ publish and term"                  |
| Sikertelen DLQ publish után `term`, az üzenet elvész          | `consumer-runner-dlq-failure.test.ts`: valódi NATS, túl kicsi DLQ, `nak` 2 perccel, később egy másolat (AT-29)     |
| Méreg-üzenet eléri a handlert vagy a fizetési providert       | `consumer-runner-dlq.test.ts` (schema, nem-JSON, verzió, AT-30); `consumer-dlq-flow.test.ts`: `providerCalls` üres |
| `poison` kimenet félig írt állapotot hagy                     | "dead-letters a handler's poison outcome…": nincs `processed_messages`, nincs outbox sor                           |
| Érvényes üzenetet is DLQ-ba tesz a kapu                       | "hands a message valid for a known version to the handler"; a flow teszt érvényes `order.placed` esete             |

## Interjúkérdések

1. **Miért fut a kapu a handler előtt?** Mert a kimerült keretű üzenet gyakran éppen azért kerül oda, mert a handler összeomlasztja a folyamatot; ha a kapu a handler után lenne, soha nem érne el. A séma ellenőrzés előtte pedig megakadályozza, hogy a fizetési provider hívás lefusson egy hibás üzeneten.
2. **Hogyan lesz a DLQ-bejegyzés pontosan egy?** A DLQ `Nats-Msg-Id` az envelope id-ből származik (`dlq:<consumer>:<id>`), így crash utáni újrapublikálás a duplikáció-ablakban nem tárolódik újra. A `term` csak a PubAck után jön.
3. **Miért `nak`, ha a DLQ publish elbukik?** A `term` végleges, DLQ-másolat nélkül adatvesztés lenne. A `nak(2 perc)` újrakézbesít, és a következő kísérlet újra próbálja a DLQ-t (AT-29).
4. **Miért a `deliveryCount` és nem saját számláló?** A broker számolja, crasht és `AckWait` lejáratot is, és túléli az újraindítást; egy memóriabeli számláló nullázódna.
5. **Mi a korlát?** A DLQ-t még semmi nem játssza vissza, a recovery script nincs kész (docs/messaging). Az ADR 0022 `payment.refunded` esete kézi replay-t igényel.
