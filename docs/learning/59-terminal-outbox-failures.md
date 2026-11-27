# 59: Terminális outbox hibák

Ticket: `issues/59-terminal-outbox-failures.md`. Commit: még nincs (munkafában). ADR: [0022](../adr/0022-terminal-failed-outbox-events.md), [0003](../adr/0003-transactional-outbox.md), [0011](../adr/0011-delivery-retry-dlq-recovery.md); TD-038.

## Probléma

Ha egy outbox eseményt soha nem lehet publikálni (például nincs hozzá stream, vagy túl nagy a payload), a relay örökké újrapróbálta, és az aggregátum összes későbbi eseménye mögötte várt (TD-038). A felhasználó oldalán egy beragadt `order.placed` mögött az `order.confirmed` sem jut el a consumerekhez. A rendszer oldalán ráadásul senki nem tudott a hibáról.

## Döntés

1. **Tartós hiba és átmeneti hiba szétválasztása.** A JetStream adapter (`jetstream-message-bus.ts`) `PermanentPublishError`-t dob, ha a hiba a sorra jellemző: `no_stream`, `payload_too_large`, `unserialisable`. Minden más (kapcsolat megszakadt, PubAck timeout, stream tele) átmeneti. A `no_stream` felismeréséhez a no-responders válasz kevés (az JetStream leállását is jelenti), ezért a relay a stream lookup 10059-es kódját is ellenőrzi (ADR 0022). Ezt valódi NATS-en rögzíti a `publish-failure-classification.test.ts`.
2. **`FAILED` végállapot, injektálható cap-pel.** Csak a tartós hibák számítanak a `permanentFailures` számlálóba; `DEFAULT_MAX_PERMANENT_FAILURES` = 5. A cap után a sor `FAILED`, megtartja a payloadot, id-t, `lastError`-t, `failedAt`-et; a relay csak `PENDING` sort claimel, így a `FAILED` sor elengedi az aggregátumát (`outbox-relay.ts`, `outbox-failures.ts`).
3. **Visszaállítás ugyanazon az id-n.** A `requeueFailedOutboxEvent` (és az `outbox:requeue` script) csak `FAILED` sort enged vissza `PENDING`-be, operátor nevével és indokkal, append-only `outbox_event_history` bejegyzéssel. Mivel az eredeti outbox id marad a `Nats-Msg-Id`, a consumerek `processed_messages` dedupe-ja miatt a dupla kézbesítés nem változtat semmit.

Kulcsötlet: a kimaradás (outage) soha nem terminális, a tartós hiba igen, és a `FAILED` sor látható, naplózott és visszaállítható, de nem blokkol.

## Alternatívák

| Alternatíva                              | Előny                      | Hátrány                                                      | Miért nem itt                                                                           |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Örök retry (a korábbi állapot)           | Egyszerű, nincs új állapot | Egy méreg-esemény megállítja az aggregátumot, nincs riasztás | Ez volt a TD-038                                                                        |
| Minden hiba számít a cap felé            | Egyszerűbb osztályozás     | Egy hosszú NATS-kiesés `FAILED`-re tenne mindent             | Az outage teszt ezt bukná                                                               |
| Sor törlése vagy dead-letter tábla       | Tiszta outbox              | Elveszik a tranzakciós audit, nehezebb a recovery            | A döntés szerint láthatónak kell maradnia                                               |
| Aggregátum zárolása, amíg ember nem dönt | Szigorú sorrend            | Egy hiba mindent megállít                                    | A maintainer az out-of-order toleráns modellt választotta (ADR 0011 DLQ is így működik) |

## Fogalmak

- **Transactional outbox**: az esemény ugyanabban a tranzakcióban kerül az outbox táblába, mint az üzleti változás; a relay publikálja később.
- **Permanent vs transient failure**: tartós hiba a sorra jellemző, újrapróbálva sem javul; átmeneti hiba a környezeté (broker).
- **Idempotency**: egy üzenet kétszeri feldolgozása ugyanazt az állapotot adja; itt `Nats-Msg-Id` és `processed_messages` biztosítja.
- **Out-of-order tolerancia**: a consumer akkor is helyesen kezel egy későbbi eseményt, ha a korábbi még nem érkezett meg.
- **Append-only history**: a státuszváltások új sorként kerülnek az `outbox_event_history`-ba, nem írják felül a régit.

## Mi romolhat el

| Hiba                                                    | Teszt                                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Outage alatt a sorok `FAILED`-be kerülnek               | `outbox-outage.test.ts`: „never makes a row FAILED, however many ticks it lasts…"                                                 |
| Rossz osztályozás                                       | `publish-failure-classification.test.ts`: `no_stream`, `payload_too_large` tartós, leállított broker átmeneti                     |
| A sor a cap után `PENDING` marad, vagy elvész a payload | `outbox-failed.test.ts`: „marks a … outbox row FAILED once…", „keeps a FAILED row whole…"                                         |
| A `FAILED` sor fogja az aggregátumát                    | `outbox-failed.test.ts`: „publishes the later rows of a failed row's aggregate in order…"                                         |
| Naplózás minden tickben                                 | „logs the transition to FAILED exactly once at error…"                                                                            |
| `PUBLISHED` sor requeue-ja                              | „refuses a row that is not FAILED…"                                                                                               |
| Későbbi esemény rossz hatást okoz                       | `failed-outbox-consumer-flow.test.ts`: `order.*` és `payment.refunded` esetek, a végállapot egyezik a sorrendhelyes kézbesítéssel |
| Requeue után dupla hatás                                | ugyanott: „publishes the requeued order.placed under its original id…"                                                            |
| Riasztás hiánya                                         | `outbox-failure-health.test.ts`: „raises the alert while a FAILED row exists, and stays live"                                     |

## Interjúkérdések

1. **Miért nem számít a kiesés a cap felé?** Egy broker-leállás minden sort érint, és magától megszűnik; ha `FAILED`-re tenné őket, kézi munkát okozna ok nélkül. Az outage teszt valódi leállított brokerrel bizonyítja.
2. **Hogyan lehet biztonságos, hogy a későbbi esemény előre megy?** Minden consumer vagy helyesen alkalmazza, vagy részleges változás nélkül elutasítja (pl. `booking-saga-refunded` `poison`-nal rollbackel, és újrakézbesítik). Az ADR 0022 táblázata soronként listázza ezt.
3. **Miért ugyanazt az outbox id-t használjuk requeue-nál?** Ez a `Nats-Msg-Id` és a dedupe kulcs, így ha a consumer már feldolgozta, a második kézbesítés nem csinál semmit. Új id-val dupla mellékhatás lehetne.
4. **Miért külön `permanentFailures` és `attempts`?** Az `attempts` minden hibát számol audit célból, a cap viszont csak a tartósakat; a requeue csak az utóbbit nullázza.
5. **Hogyan veszi észre az operátor?** Egyszer `error` szintű log sor a váltáskor (payload nélkül), és a worker `/health` `outbox.alert` jelzője, ami nem buktatja el a liveness-t. A runbook: `docs/messaging/failed-outbox-event.md`.
