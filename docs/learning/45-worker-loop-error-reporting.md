# 45: Worker loop hibák naplózása

Ticket: `issues/45-worker-loop-error-reporting.md`. Commit: még nincs (munkafában). ADR: [0011](../adr/0011-delivery-retry-dlq-recovery.md) említve (DLQ nélkül nincs `term`); a TD-031 és TD-032 bejegyzés a `docs/technical-debt.md`-ben.

## Probléma

Az outbox relay és a consumer runner végtelen ciklus: ha az adatbázis vagy a broker kiesik, a ciklus nem állhat le. Korábban viszont az üres `catch {}` mindent lenyelt, így egy üzemeltető nem látta, hogy a relay vagy a consumer hónapok óta hibázik. Fordítva, ha minden 250 ms-es tick naplózna, egy kiesés alatt elárasztaná a logot.

## Döntés

1. **Minden hiba naplózva, a ciklus fut tovább.** A relay `catch (error)` ága és a consumer runner poll ága `error` szinten naplózza az okot (`outbox relay tick failed`, `consumer poll failed`), a ciklus pedig újrapróbál. A relay tranzakciója visszagördül, a sorok `PENDING`-ek maradnak, ezért a kiesés után kiadódnak (`outbox-relay.ts`, `consumer-runner.ts`).
2. **Közös, rate-limitelt `FailureReporter`** (`packages/messaging/src/failure-reporter.ts`). Okonként (`name: message` alapján) naplózza az első hibát, majd okonként legfeljebb 60 másodpercenként egy sort `failures` és `suppressed` számlálóval, váltakozó okok esetén is. Legfeljebb 32 ok ablakát tartja (`MAX_TRACKED_FAILURE_CAUSES`), azon túl a legrégebben naplózottat elfelejti. Az első sikeres iteráció után egy `info` sor jön `failures` és `outageMs` mezővel. Az óra injektálható (`now`), így a teszt determinisztikus.
3. **Handler hiba naplózása a `nak` előtt**: `error` szinten, az error-ral és a `deliveryCount`-tal. A poison üzenet végtelen újraszállítását ez nem szünteti meg: azt a ticket 25 DLQ kapuja oldja meg, mert az ADR 0011 DLQ-másolat nélkül tiltja a `term`-et (`docs/messaging/index.md`).

A kulcsötlet: a hiba _láthatósága_ és a _napló mennyisége_ két külön követelmény, ezért a riporter az ismétlődést számolja, nem eldobja.

## Alternatívák

| Alternatíva                               | Előny                            | Hátrány                                                  | Miért nem itt                                                                       |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Minden hibát naplózni tickenként          | Egyszerű, semmi nem vész el      | Kiesésnél 4 sor/másodperc, a log használhatatlan         | A ticket kifejezetten rate limitet kér                                              |
| Csak az első hibát naplózni, a többit nem | Nagyon kevés zaj                 | Új ok (pl. kapcsolat után hibás query) láthatatlan marad | Az ok szerinti különbségtétel ezt kezeli                                            |
| Metrika/alert (counter) log helyett       | Aggregálható, riasztható         | Külön infrastruktúra, az ok nem derül ki                 | Általános megközelítés; itt nincs metrika-réteg, a log elég (a mérést nem végeztük) |
| A ciklus leállítása hibánál               | Hangos, a supervisor újraindítja | Egy átmeneti kiesés leállítja a publikálást              | A relay-nek túl kell élnie a kiesést                                                |

## Fogalmak

- **Rate limiting (log)**: ugyanazt a hibát időablakonként legfeljebb egyszer írjuk ki, a kihagyottakat megszámoljuk.
- **Outbox relay**: az outbox táblából (a változással azonos tranzakcióban írt sorok) publikál a brokerre; sikertelen tick után a sor `PENDING` marad.
- **`nak`**: a consumer jelzi a brokernek, hogy az üzenetet újra kell szállítani; `deliveryCount` mutatja, hányadik próbálkozás.
- **Poison message**: olyan üzenet, amelyet a handler mindig elutasít; DLQ nélkül végtelenül újraszállítódik.
- **Injektált óra**: a `now` függvény a tesztben kontrollálható, így nem kell valódi időt várni.

## Mi romolhat el

| Hiba                                                             | Teszt                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elérhetetlen DB mellett a relay csendben hibázik, vagy leáll     | `outbox-relay-logging.test.ts`: „logs a tick that fails outside a row's publish…" (Proxy-val kapcsolt kiesés, `PENDING` marad, kiesés után `PUBLISHED`)    |
| Tartós kiesés elárasztja a logot, vagy nem látszik a helyreállás | ugyanott: „rate-limits identical failures…" (kontrollált óra: 1 sor az ablakon belül, 2. sor `suppressed`-del, `outbox relay recovered` `outageMs: 65000`) |
| A broker elérhetetlen, a consumer nem naplóz vagy leáll          | `consumer-runner-logging.test.ts`: „logs a failed fetch at error…" (`CONNECTION_REFUSED`, utána feldolgozás)                                               |
| Handler hiba napló nélkül, vagy a `nak` után naplózva            | ugyanott: „logs a handler failure…" (sorrend: napló `deliveryCount: 1`, majd `nak`)                                                                        |

Nyitott: a `docs/technical-debt.md` bejegyzéseit nem frissítették (a CLAUDE.md fagyasztja); a ticket utolsó pontja emiatt nyitott, a kérdés a `.devflow/questions.md`-ben van.

## Interjúkérdések

1. **Miért nem naplózunk minden sikertelen tickre?** Egy kiesés alatt a 250 ms-es ciklus másodpercenként több sort írna, ami elnyomja a többi jelet. A `FailureReporter` az első hibát és az új okokat azonnal, az ismétlődőt 60 s-onként írja ki számlálóval.
2. **Hogyan teszteltétek az időalapú rate limitet?** A relay opcionális `now` órát kap, a teszt ezt lépteti 30 s-mal, majd még 30 s-mal. Így nincs sleep, és pontosan állítható: 1 sor, majd 2, majd a helyreállás `outageMs: 65000`.
3. **Mi garantálja, hogy kiesés közben nem vész el esemény?** A hibás tick tranzakciója visszagördül, a sor `PENDING` marad, a következő tick újra felveszi. Ezt a teszt ellenőrzi: kiesés alatt `PENDING`, utána `PUBLISHED`.
4. **Miért nem oldja meg ez a ticket a poison üzenetet?** Mert a végtelen újraszállítás megszüntetéséhez `term` kell, azt az ADR 0011 csak DLQ-másolattal engedi. Itt csak láthatóvá tettük (hiba + `deliveryCount`), a kaput a ticket 25 építi.
5. **Miért közös a riporter a relay és a consumer között?** Ugyanaz a probléma (háttérciklus ismétlődő hibája), így egy kis modul egy helyen tartja a szabályt; a két hívó csak az üzenetszövegben tér el.
