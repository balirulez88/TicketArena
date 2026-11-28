# 27: Consumer recovery és outbox re-publish

Ticket: `issues/27-consumer-recovery-and-outbox-republish.md`. Commit: még nincs (munkafában). ADR: [0011](../adr/0011-delivery-retry-dlq-recovery.md), [0022](../adr/0022-terminal-failed-outbox-events.md), [0024](../adr/0024-frozen-debt-register-check.md). Runbook: `docs/messaging/consumer-recovery.md`.

## Probléma

Ha egy durable consumert újra kell létrehozni (törölték, vagy a broker adata elveszett), a kezdőpontot valahogy meg kell választani. Rossz választásnál egy fel nem dolgozott üzenet kimarad, és például egy fizetés vagy refund soha nem történik meg. A rendszer oldalán az üzenetek rendezetlenül is feldolgozódhatnak, ezért a "legmagasabb feldolgozott sorszám" nem mond semmit az alatta lévőkről.

## Döntés

1. **Három szabály, rögzített sorrendben** (`consumer-recovery.ts`, `recreateConsumer`). (a) Ha van **ack floor**, a start `ack_floor + 1`. (b) Ha nincs, de a `processed_messages` megbízható checkpoint, a script végigolvassa a megmaradt streamet a consumer filterével, és az első olyan üzenetnél indul, amelyhez nincs sor. (c) Különben a legkorábbi megmaradt üzenettől. A kulcs ötlet: **soha nem skippelünk, legfeljebb újrajátszunk**, mert a `processed_messages` dedupe elnyeli a duplikátumot. Időbélyegből vagy "max - margin" értékből sosem származik start; a `now` csak azt dönti el, hogy a (b) szabály használható-e (a stream első üzenete újabb-e a 14 napos retentionnél).
2. **Outbox re-publish** (`outbox-republish.ts`): ha az üzenet már nincs a streamben (a NATS volume elveszett), a `PUBLISHED` sorok egy időtartományban `PENDING`-re kerülnek, és a relay **az eredeti id-n** újra publikálja őket. Egy tranzakcióban history sor is készül operátorral és okkal. `FAILED` sorhoz nem nyúl.
3. **Retention job** (`outbox-retention.ts`): óránként törli a 14 napnál régebbi `PUBLISHED` outbox sorokat és `processed_messages` sorokat. A 14 nap hosszabb a stream 7 napjánál, így a recovery mindig elér a streamen túl. Nem töröl `FAILED` sort, history-s sort, és olyan `unknown_order` refund kérést, amelynek még nincs orphan obligationje (ticket 70).

Mellékes, de ide tartozik: a payment kihagyja az `order.placed`-et, ha a `paymentDeadline` feldolgozáskor lejárt (ack és log), hogy egy replay ne fizettessen le lejárt ordert.

## Alternatívák

| Alternatíva                                   | Előny                    | Hátrány                                                          | Miért nem itt                                                      |
| --------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Start időbélyegtől (`--deliver <time>`)       | Egyszerű, kézzel is megy | Rendezetlen feldolgozásnál feldolgozatlan üzenetet skippelhet    | A runbook kifejezetten tiltja                                      |
| Start a legmagasabb feldolgozott sorszám után | Gyors, nincs scan        | A nála alacsonyabb feldolgozatlan üzenetek kimaradnak (AT-33)    | Skippelés; a scan az első lyukat keresi                            |
| Mindig a legkorábbi üzenettől                 | Nincs skip, nincs scan   | Nagy streamnél sok felesleges újrakézbesítés                     | Csak végső tartalék (c); az (a) és (b) szűkít                      |
| Kézi SQL az outbox visszaállításához          | Nincs új script          | Nincs audit, új id-ra is lehet szúrni, `FAILED` sort is érinthet | Az eredeti id és a history kell a dedupe-hoz és a nyomonkövetéshez |

## Fogalmak

- **Durable consumer**: névvel a brokerben megőrzött olvasási pozíció; törlésével a pozíció elvész.
- **Ack floor**: az a sorszám, amelyig minden üzenet lezárt. Egy `term`-ölt (DLQ-ba tett) üzenetet is lezártnak számol, ezért DLQ replay-hez `--ignore-ack-floor` kell.
- **Checkpoint**: itt a `processed_messages` tábla, amely consumerenként rögzíti a feldolgozott envelope id-ket.
- **Idempotens consumer**: ugyanazt az üzenetet többször kapva is csak egyszer hat; ez teszi az újrajátszást biztonságossá.
- **Retention**: az adatok korlátos élettartama; a 14 napos határ a recovery felső korlátja.

## Mi romolhat el

| Hiba                                                                | Teszt                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Rendezetlen részleges feldolgozás után üzenet marad ki ack floornál | `consumer-recovery.test.ts`: "AT-32: with an ack floor after out-of-order processing, resumes at ack_floor + 1…"  |
| {1,2,3,5} feldolgozva, a 4 kimarad                                  | ugyanott: "AT-33: … resumes at 4; 5 is redelivered and deduped"                                                   |
| Checkpoint nélkül dupla mellékhatás                                 | ugyanott: "AT-34: … replays from the earliest retained message with no duplicate side effects"                    |
| Másik filter ack floorja félrevezet                                 | "does not use an ack floor recorded under another filter subject"                                                 |
| Broker adatvesztés után az újrapublikált üzenet kétszer hat         | `outbox-republish.test.ts`: "after broker data loss, re-publishes under the original id and a consumer … dedupes" |
| `FAILED` vagy `PENDING` sor véletlenül visszakerül                  | "never touches a FAILED or a PENDING row…"                                                                        |
| A retention olyat töröl, amit még kell (`FAILED`, history, orphan)  | `outbox-retention.test.ts`: "never deletes a FAILED row…", "keeps an unknown_order refund request…"               |
| Replay lejárt orderre fizet                                         | `payment-handler.test.ts`: "skips an order.placed whose paymentDeadline has passed at processing time…"           |

## Interjúkérdések

1. **Miért nem a legmagasabb feldolgozott sorszámtól indul?** Mert az üzenetek rendezetlenül dolgozódnak fel: {1,2,3,5} esetén az 5 a maximum, de a 4 még feldolgozatlan. A scan az első sor nélküli üzenetnél indul (AT-33), az 5 pedig duplikátumként elnyelődik.
2. **Miért biztonságos az újrajátszás?** Minden consumer az envelope id-n dedupe-ol a `processed_messages` táblával, az outbox re-publish pedig az eredeti id-t tartja meg. Ezért az elv: duplikálni szabad, skippelni nem.
3. **Mikor megbízható a checkpoint?** Ha a stream első megmaradt üzenete újabb a 14 napos `processed_messages` retentionnél, mert akkor egyetlen megmaradt üzenet sorát sem törölhette a job. Egyébként a legkorábbi üzenettől játszunk újra (`consumer-recovery.ts`, `reliable`).
4. **Miért kell `--ignore-ack-floor` DLQ replay-hez?** A `term`-ölt üzenet a JetStream szerint lezárt, az ack floor átlépte, ezért az (a) szabály sosem kézbesítené újra. A scan a `processed_messages` alapján megtalálja.
5. **Mi a korlát?** A 14 napnál régebbi eseményeket automatikusan nem lehet visszaállítani: az outbox sor törlődött, és a dedupe sor sem védene. A runbook ezt dokumentálja.
