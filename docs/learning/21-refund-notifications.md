# 21: Refund értesítések

Ticket: `issues/21-refund-notifications.md`; commit: még nincs; ADR: 0009 (per-service schemas).

## Probléma

A vevő a késői fizetés után nem tudta, hogy pénzt kap vissza. A rendszer oldaláról a Notification service eddig csak három eseményt ismert (`order.confirmed`, `order.cancelled`, `order.expired`). A refund két új eseményét (`payment.refund_requested`, `payment.refunded`) nem fogyasztotta, és nem volt bizonyíték arra, hogy minden végállapot pontosan egy értesítést ad csatornánként.

## Döntés

Nem épült új szolgáltatás: a meglévő `createNotificationHandler` kapott két új esemény-típust. Három döntés számít:

1. **Egy handler, több durable consumer.** Egy durable consumer csak egy `filterSubject`-et fogad, ezért két új consumer jött létre (`notification-refund-requested`, `notification-refunded`) ugyanazzal a handlerrel (`apps/worker/src/consumers.ts`). A handler `z.discriminatedUnion("type", ...)` sémával validál, és egy `TEMPLATES` térkép választ sablont (`refund-initiated`, `refund-completed`).
2. **Dedupe az esemény azonosítóján.** A `notification.notifications` táblán egyedi `(sourceEventId, channel)` kulcs van, plusz a consumer `processed_messages` táblája. Ez adja a "pontosan egy rekord csatornánként" garanciát újraküldésnél és ugyanazon event másolatánál is. A küldés előtt `PENDING` sor commitolódik, a provider hívása `idempotencyKey = notification id`-vel megy, majd `SENT` lesz.
3. **Contact nélküli refund: ack, nincs rekord.** Csak az `unknown_order` refundnak nincs `contact`-ja (nincs vevő). A handler infón logol és `undefined`-dal visszatér (ack), mert újrapróbálás sosem hozna címzettet (`notification-handler.ts`).

Ismert korlát (dokumentálva a `docs/messaging/index.md`-ben): ha egy jövőbeli reconciler ugyanazt a refund kérést új event id-vel bocsátja ki, az új forrás-esemény, ezért második `refund-initiated` megy ki.

## Alternatívák

| Alternatíva                                        | Előny                            | Hátrány                                                                                                              | Miért nem itt                                                               |
| -------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Értesítés közvetlenül a Payment/saga tranzakcióban | Egyszerű, nincs új consumer      | Összekeveri a szolgáltatások felelősségét, a provider-hívás a tranzakcióban lógna                                    | ADR 0009: minden szolgáltatás a saját táblájával és eseményen át kommunikál |
| Dedupe `orderId` + sablon alapján                  | Reconler re-emitnél sem duplázna | Egy orderhez több refund is lehet, a kulcs rossz összevonást adna                                                    | A projekt konzisztensen `sourceEventId`-t használ; a korlátot dokumentálták |
| Contact nélküli esemény retry-ja / dead-letter     | "Semmi sem vész el"              | Végtelen vagy értelmetlen retry, nincs címzett                                                                       | Újrapróbálás nem hozhat címzettet, ack a helyes                             |
| Egy consumer több subjecttel                       | Kevesebb consumer                | A durable consumer egy filter subjectet enged (ez általános NATS-tudás, a projekt dokumentációja is erre hivatkozik) | Egy consumer / subject marad                                                |

## Fogalmak

- **Durable consumer**: névvel megőrzött előfizetés, a bus emlékszik, meddig dolgoztunk fel.
- **Idempotency**: ugyanaz az input többször is ugyanazt az eredményt adja. Itt: unique kulcs + `processed_messages`.
- **At-least-once**: az üzenet legalább egyszer megérkezik, ezért duplikátumra fel kell készülni. A külső kézbesítés itt is ilyen (összeomlás a hívás és a `SENT` között újrahív), csak a provider key-dedupe fogja fel.
- **Ack / nak**: az ack lezárja az üzenetet, a nak újraküldést kér.
- **Outbox**: az eseményt a változással egy tranzakcióban írjuk, hogy ne vesszen el.

## Mi romolhat el

| Hiba                                                            | Teszt                                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Provider elhasal, redelivery után kettő helyett csonka eredmény | AT-43 `it.each`: az első küldés hibázik, a nak után újra jön; várja a 2 `SENT` sort                              |
| Ugyanaz az event új message id-vel kétszer értesít              | ugyanaz a teszt `-dup` msgId-vel: továbbra is egy sor csatornánként, a delivery kulcsok egyeznek a sor id-kkal   |
| Contact nélküli refund végtelen retry vagy üres rekord          | `acks a %s without a contact and records nothing`                                                                |
| Rossz sablon / csatorna (SMS telefon nélkül)                    | `records a refund-initiated email and SMS ...`, `records a refund-completed email ...`                           |
| Az új consumerek nincsenek bekötve                              | `refund-flow.test.ts`: a teljes folyamat végén `order-expiry`, `refund-initiated`, `refund-completed` kézbesítés |

## Interjúkérdések

1. **Hogyan lesz pontosan egy értesítés csatornánként duplikált kézbesítésnél?** Unique `(sourceEventId, channel)` a táblán, és a consumer `processed_messages` táblája. Az újrakézbesítés a meglévő `PENDING` sort folytatja, nem újat hoz létre.
2. **Miért írják a `PENDING` sort a provider hívás előtt, külön tranzakcióban?** Hogy hiba esetén a sor megmaradjon, és az újrapróbálás ugyanazzal a kulccsal (notification id) hívja a providert. Így a külső kézbesítés at-least-once, de a kulcs-dedupe elnyeli a duplikátumot.
3. **Miért ackeli a handler a contact nélküli eseményt?** Az `unknown_order` esetben nincs vevő, és újrapróbálás sem hoz címzettet. A retry csak a feldolgozást blokkolná.
4. **Mi a dedupe korlátja?** Event id szerint dedupe-ol, ezért egy új id-vel újra kibocsátott `payment.refund_requested` második `refund-initiated`-et küldene. Ezt a reconciler ticketnél kell kezelni.
5. **Miért két új consumer, nem egy?** A durable consumer egy filter subjectet kezel, ezért subjectenként egy consumer fut ugyanazzal a handlerrel.
