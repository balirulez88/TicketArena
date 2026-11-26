# 26: Stream backpressure és topology hardening

Ticket: `issues/26-stream-backpressure-and-topology.md`; commit: még nincs; ADR: 0004 (NATS JetStream message bus), 0009 (szolgáltatásonkénti sémák, így szolgáltatásonkénti outbox).

## Probléma

Az események egy outbox táblán keresztül jutnak a JetStreamre: a relay a `PENDING` sorokat publikálja. Ha a stream megtelik, két rossz végkifejlet lenne: a broker eldobja a régi üzeneteket, vagy a relay hibát nyel, és az esemény elvész. Közben az `ensureTopology()` induláskor fut, és ha bármilyen hiba után `update`-et próbál, az eredeti hiba oka elvész (TD-036).

## Döntés

1. **`discard: new` backpressure.** A streamek `max_bytes` határral és `DiscardPolicy.New`-val jönnek létre (`packages/messaging/src/jetstream-message-bus.ts`). Teli streamnél a broker az _új_ publish-t utasítja el, a tárolt üzenetet nem törli. A relay a hibát a soron rögzíti (`attempts`, `lastError`), a sor `PENDING` marad, és a hely felszabadulása után újra próbálja. A kulcsötlet: az outbox a hiteles forrás, a stream csak szállítás, ezért az elutasítás biztonságos. A `streamMaxBytes` opció csak azért van, hogy a teszt kis streamet tölthessen meg; production az ADR 0004 méreteit használja.
2. **Szűk catch az `ensureTopology()`-ban.** Az `add` idempotens azonos konfigra, eltérőre hibát ad. Csak ha ez a hiba a "stream név már használatban" (`JetStreamApiError`, kód 10058), akkor fut az `update`, amely helyben konvergálja a régi konfigot. Minden más hiba (érvénytelen konfig, nem elérhető broker) az eredeti okkal tovább dobódik.
3. **Outbox lag** (`outbox-lag.ts`, `measureOutboxLag`): a legrégebbi `PENDING` sor kora ms-ban, 0 ha nincs ilyen. A lekérdezés szolgáltatásonként a `service-store.ts`-ben él (`oldestPendingCreatedAt`). A hívó adja az `now`-t, és a negatív érték 0-ra vágódik, mert a sorokat az adatbázis órája bélyegzi.

## Alternatívák

| Alternatíva                                 | Előny                      | Hátrány                                           | Miért nem itt                                            |
| ------------------------------------------- | -------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `discard: old` (a régi üzenetek törlése)    | a publish soha nem hibázik | csendben elvész egy még fel nem dolgozott esemény | az eseményvesztés elfogadhatatlan, az outbox úgyis tárol |
| Végtelen stream (nincs `max_bytes`)         | nincs backpressure         | a lemez betelhet, a node leáll                    | a korlát védi a brokert (ADR 0004)                       |
| Bare `catch {}` az `add` körül (a régi kód) | egyszerű                   | minden hibát konfigeltérésnek néz, az ok elvész   | pont ez a TD-036                                         |
| Mindig `update`, `add` nélkül               | nincs kivételes ág         | nem létező streamet nem hoz létre                 | az `add` kell az első indításhoz                         |

## Fogalmak

- **Backpressure**: ha a fogadó fél tele van, a küldő lassul vagy vár, nem veszít adatot. Itt a publish elutasítása a jel, a várakozó hely az outbox.
- **Outbox**: az eseményt az üzleti változással egy tranzakcióban írjuk egy táblába, egy relay később publikálja. Így nincs "írtunk, de nem publikáltunk" állapot.
- **`discard: new` és `max_bytes`**: a stream méretkorlátja, és a policy, hogy teli streamnél mi történik. `new` az újat dobja el.
- **Idempotens topology**: az `ensureTopology()` bármikor újrafuttatható, ugyanarra az állapotra jut.
- **Outbox lag**: a legrégebbi még el nem küldött esemény kora; nő, ha a relay nem tud publikálni.

## Mi romolhat el

| Hibamód                                                                    | Teszt                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Teli stream eldob egy tárolt üzenetet                                      | `stream-backpressure.test.ts`: elutasítja a publisht, az üzenetszám és a `first_seq` változatlan            |
| A relay elveszti az eseményt, vagy nem küldi el a hely felszabadulása után | ugyanott: a sorok `PENDING`, `attempts` 1, `lastError` "maximum bytes", végül mind `PUBLISHED`              |
| Régi konfigú stream nem konvergál                                          | `jetstream-message-bus.test.ts`: "falls back to update only when the stream already exists"                 |
| Az `add` hiba oka elvész, vagy fölösleges update fut                       | ugyanott: átfedő subject esetén `JetStreamApiError` "overlap", nincs update; zárt kapcsolat esetén "closed" |
| Negatív vagy hibás lag, más szolgáltatás outboxa                           | `outbox-lag.test.ts`: a legrégebbi `PENDING`, publikált sor kihagyva, 0 ha üres, szolgáltatásonként         |

A ticket szerint a bare `catch {}` visszaállítása a második tesztet pirosra váltja.

## Interjúkérdések

1. **Miért `discard: new`, és nem `old`?** A `new` az újat utasítja el, a már tárolt üzenet megmarad, a relay pedig az outboxban tartja az eseményt. A `old` csendben törölné a még fel nem dolgozott eseményt.
2. **Mit mér az outbox lag, és mire jó?** A legrégebbi `PENDING` sor korát. Ha a relay nem tud publikálni (broker leállt, stream tele), nő, ezért a dashboardon ez jelzi, hogy az események késnek, de nem vesztek el.
3. **Mi baj volt a bare `catch {}`-csel?** Időtúllépést vagy érvénytelen konfigot is konfigeltérésnek vett, az `update` más hibát dobott, és az eredeti ok elveszett. Most csak a 10058-as kód vált `update`-re.
4. **Honnan tudod, hogy az újrapróbálás nem duplikál?** A publish `Nats-Msg-Id` fejlécet használ, a stream duplicate window-ja kiszűri az ismétlést, a fogyasztók pedig idempotensek (CLAUDE.md szabály). A részleteket a `docs/messaging` írja le.
