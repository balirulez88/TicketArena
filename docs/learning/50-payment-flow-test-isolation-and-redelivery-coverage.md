# 50: Payment-flow tesztizoláció és redelivery lefedettség

Ticket: `issues/50-payment-flow-test-isolation-and-redelivery-coverage.md`; commit: még nincs; ADR: 0007 (three-layer idempotency), 0011 (delivery, retry, DLQ).

## Probléma

A fizetési és értesítési folyamat tesztjei egymás üzeneteit is megkapták (közös NATS stream), ezért a pontos darabszámokat nem lehetett állítani. Nem volt bizonyítva az sem, hogy egy sikertelen értesítés ugyanaz az üzenet marad `nak` után. Az sem volt specifikálva, mit csinál a Payment, ha ugyanaz az `order.placed` **új event id-vel** érkezik újra: a `processed_messages` tábla ezt nem fogja meg, a `(orderId, attemptNo)` egyedi kulcs viszont igen, és a unique violation visszagörgetné a tranzakciót, vagyis végtelen redelivery jönne.

## Döntés

1. **Idempotens skip az üzleti kulcson (TD-053).** A `payment-handler.ts` `recordAttempt` függvénye `paymentAttempt.createMany({ skipDuplicates: true })`-t használ, ami `INSERT ... ON CONFLICT DO NOTHING`. Ha 0 sor íródott, a handler `undefined`-dal tér vissza: ack, nincs második kísérlet és nincs második `payment.succeeded`/`payment.failed`. Az első kísérlet eredménye már kiment. A kulcs: a skip a _kimenet emittálása előtt_ történik, ugyanabban a tranzakcióban.
2. **Valódi race teszt.** A `payment-handler.test.ts` két runnert indít külön kapcsolaton és `application_name`-mel. A `LOCK TABLE payment.outbox_events IN SHARE MODE` megállítja az elsőt az attempt insert után, még nyitott tranzakcióban. A `pg_stat_activity` (`wait_event_type = 'Lock'`) lekérdezésével a teszt _megvárja_, hogy mindkét tranzakció blokkolva álljon, és csak utána engedi el a zárat. Így nincs `sleep`: a feltételre várunk, nem időre.
3. **Izoláció és pontos számok.** A `payment-flow.test.ts` tesztenként új streameket és subject prefixet kap (`isolatedBus`), a `drain(orderId)` pedig megvárja, hogy a folyamat lecsengjen, mielőtt a worker leáll. Az értesítéseknél a `nak` utáni redelivery azonos `msgId`-vel és `streamSeq`-kel érkezik, és a részleges hiba (EMAIL elment, SMS bukik) után mindkét csatorna `SENT` lesz, ugyanazokkal a kulcsokkal.

## Alternatívák

| Alternatíva                                   | Előny             | Hátrány                                                      | Miért nem itt                                |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Hagyni a unique violationt (hiba, redelivery) | Nincs kódváltozás | Végtelen retry, mert a második insert mindig elbukik         | A repeat sosem sikerülhet, csak terhel       |
| Előbb `SELECT`, aztán `INSERT`                | Egyszerű olvasni  | Check-then-act race: két tranzakció is látja, hogy nincs sor | Épp a race a kérdés                          |
| Advisory lock az order-en                     | Sorosít           | Extra zár és sorrend, a kulcs már megvan az adatban          | Az `ON CONFLICT` kevesebb mozgó alkatrész    |
| `sleep` a race tesztben                       | Gyors megírni     | Flaky, gépfüggő                                              | `pg_stat_activity` feltétel determinisztikus |
| Közös stream, szűrés a kézbesítésekre         | Kevesebb setup    | Elrejti a szivárgást, nem pontos darabszám                   | A ticket pontos számokat kér                 |

## Fogalmak

- **Idempotency**: ugyanaz a bemenet többször feldolgozva ugyanazt az állapotot adja. Itt három réteg van (ADR 0007): üzenet-szint (`processed_messages`), üzleti kulcs (`orderId, attemptNo`), provider kulcs.
- **`ON CONFLICT DO NOTHING`**: a Postgres nem hibázik ütközéskor, csak nem szúr be. Párhuzamos insert megvárja a másik nem commitolt sorát, aztán kihagyja.
- **`nak` és redelivery**: a negatív visszajelzés után a broker ugyanazt az üzenetet küldi újra (at-least-once).
- **Race condition**: az eredmény az időzítéstől függ. Determinisztikus teszthez kényszeríteni kell az átlapolódást.
- **Durable consumer**: a broker által megjegyzett pozíció. Ha tesztek osztják, egymás maradék üzeneteit kapják.

## Mi romolhat el

| Hiba                                                                      | Teszt                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Ismételt `order.placed` új id-vel második attemptet/eventet ad            | `TD-053: skips an order.placed redelivered under a new event id...`  |
| Két egyidejű feldolgozás: dupla attempt vagy unique violation retry-hurok | `TD-053: two order.placed ... race on separate connections...`       |
| Sikertelen attempt ismétlése második `payment.failed`-et ad               | `TD-053: skips the repeat of a failed attempt too...`                |
| Érvénytelen payload elnyelődik (ack) vagy mellékhatást okoz               | `TD-053: rejects an invalid order.placed without side effects...`    |
| `nak` után új üzenet vagy új kulcs lesz                                   | `TD-062: a failed send is nak'd, redelivered as the same message...` |
| EMAIL elment, SMS bukott: duplikált vagy hiányzó küldés                   | `TD-062: an SMS that fails after the EMAIL was sent...`              |
| Más teszt eventje szivárog be                                             | `payment-flow.test.ts` pontos számai az `isolatedBus` mellett        |

## Interjúkérdések

1. **Miért nem elég a `processed_messages`?** Az az üzenet id-ját dedupolja. Az ismételt `order.placed` új id-t kap, ezért kell az üzleti kulcs `(orderId, attemptNo)`. Ez az ADR 0007 több rétege.
2. **Miért skip és nem hiba?** A hiba rollbackelne, a redelivery ugyanúgy elbukna, így végtelen hurok lenne. A skip ackel, mert az első eredmény már kiment az outboxon.
3. **Hogyan teszteltél race-t sleep nélkül?** Table lockkal megállítottam az első tranzakciót, `pg_stat_activity`-ből megvártam, hogy mindkét kapcsolat `Lock`-on vár, majd elengedtem. A teszt feltételre vár, ezért stabil.
4. **Mi a különbség a check-then-insert és az `ON CONFLICT` között?** Az első két tranzakcióban is "üresnek" látszhat, a második az adatbázis egyediségi garanciáját használja, atomikusan.
5. **Miért kell drain a worker leállítása előtt?** Különben a félkész folyamat üzenetei a következő tesztre csúsznak, és a darabszám nem pontos. (Általános elv, itt a `drain(orderId)` valósítja meg.)
