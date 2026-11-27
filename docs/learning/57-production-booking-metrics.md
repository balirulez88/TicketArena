# 57: Produkciós booking metrikák

Ticket: `issues/57-production-booking-metrics.md` · commit: még nincs (`devflow/run-202611261713` ág) · ADR: [0005](../adr/0005-postgres-seat-state-row-locks.md), [0010](../adr/0010-real-infrastructure-tests.md)

## Probléma

A booking service már tudott metrikát számolni (`hold_ok`, `booking_busy`, `deadlock_retry`), de a futó webalkalmazás a `holdSeats` és a `placeOrder` hívásakor nem kapott `BookingMetrics` példányt (TD-070). Az admin dashboard ezért produkcióban nullákat mutatott, miközben a `docs/index.md` ennél többet állított. A számláló viszont soha nem akadályozhatja a foglalást: egy lassú vagy halott Upstash nem tehet tönkre egy vásárlást.

## Döntés

1. **A context adja a metrikát, de csak a foglaló procedure kéri el.** A `booking.holdSeats` és a `booking.placeOrder` az `optionalMetrics(ctx)` hívással kapja meg a `ctx.metrics()` értékét (`apps/web/src/server/trpc.ts`, `routers/booking.ts`). A `getHold`, `activeHold`, `releaseHold` és `getOrder` nem oldja fel. Ha az Upstash nincs konfigurálva, `undefined` jön vissza, és a foglalás számlálás nélkül lefut. A konfigurációs hibát a lusta függőség egyszer naplózza a határon (ticket 56), kérésenként nem.
2. **Best-effort, nem várt increment.** A `booking-service.ts` az incrementet nem `await`-eli: `metrics.increment(...).catch(failed)`, a hiba `metric failed` sorként kerül a naplóba a metrika nevével és az `eventId`-val. A foglalás eredménye így nem függ az Upstash válaszától. Ennek ára, hogy ha a platform a válasz után megöli a kérést (például serverless), egy increment elveszhet. A számláló dashboardra való, döntésre soha.
3. **Tesztelhető összeállítás.** A `createContextServices` egy folyamat közös szolgáltatásait (logger, lusta metrics, rate limiter, queue store) építi `readEnv` fölött, a `createTRPCContextFactory(booking, services)` pedig ezt kapja. Így a teszt a valódi context factoryt használja saját környezettel. Az egyetlen mock a rendszerhatár: a helyi `fake-upstash.ts` HTTP szerver (módok: `ok`, `error`, `silent`). A Postgres valódi (ADR 0010).

## Alternatívák

| Alternatíva                                 | Előny                     | Hátrány                                                        | Miért nem itt                                                               |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Metrika nélküli service (a korábbi állapot) | Egyszerű                  | A produkciós számlálók üresek maradnak                         | Ez maga TD-070                                                              |
| `await` az incrementre                      | Nem vész el számláló      | Lassú vagy néma Upstash késlelteti vagy elbuktatja a foglalást | A néma szerveres teszt ezt kapná el (2 s request timeout után térne vissza) |
| Metrika az outboxon át, tranzakcióban       | Nem vész el, konzisztens  | Plusz írás a forró úton, a dashboardnak nem kell pontosság     | ADR 0005: a seat state Postgresé, a számláló csak megfigyelés               |
| Hiba dobása, ha az Upstash hiányzik         | Hangos konfigurációs hiba | Egy opcionális számláló miatt áll a foglalás                   | A foglalás fontosabb, ahogy az `admin.runRace` is számlálás nélkül fut      |

A táblázat harmadik sora általános kompromisszum az outbox mintáról, nem mért adat ebből a projektből.

## Fogalmak

- **Best-effort**: a művelet megpróbálódik, de a hibája nem terjed tovább a hívóra. Itt az increment hibája csak naplósor.
- **Fire-and-forget**: a hívó nem várja meg az aszinkron művelet végét. Gyors, de a háttérmunka a kérés után elveszhet.
- **`HINCRBY`**: atomi Redis hash-számláló növelés. A kulcs `booking:metrics:<eventId>`, a mező a metrika neve.
- **Lusta függőség (lazy dependency)**: első használatkor épül, és csak akkor kell hozzá konfiguráció.
- **Rendszerhatár fake**: csak a külső hálózati végpontot cseréljük helyi szerverre, a saját modulok valódiak maradnak.
- **Ismeretlen esemény kulcs**: ha a `placeOrder` még a hold beolvasása előtt `booking_busy`-t kap, az esemény nem ismert, ezért a `unknown` kulcsra számol (`UNKNOWN_EVENT_METRICS_KEY`).

## Mi mehet félre

| Hibamód                                                            | Teszt (`booking-metrics.test.ts`)                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A service metrika nélkül épül, a számlálók nem érnek az Upstashhoz | `holdSeats and placeOrder count through the one metrics instance`, valamint a pontos `HINCRBY` parancsokat vizsgáló end-to-end tesztek |
| Nem foglaló procedure feloldja a metrikát                          | `procedures that do not book never resolve the metrics`                                                                                |
| Lock timeout kimerítése rossz számokat ad                          | `exhausts its lock-timeout retries`: háromszor `deadlock_retry`, egyszer `booking_busy`                                                |
| Telített pool, ismeretlen event                                    | `saturated pool`: `booking_busy` az `unknown` kulcsra a `placeOrder`-nél                                                               |
| Valódi `40001` retry nincs megszámolva                             | `retried once after a real 40001`: egy `deadlock_retry`                                                                                |
| Az Upstash 500-at ad vagy elutasítja a kapcsolatot                 | a `test.each` eset: a foglalás sikeres, soronként egy `metric failed`                                                                  |
| Az Upstash soha nem válaszol                                       | `never answers`: a foglalás azelőtt tér vissza, hogy a hiba naplózódna                                                                 |
| Hiányzó Upstash konfiguráció                                       | `without an Upstash configuration`: a foglalás sikeres, a hiba egyszer naplózva                                                        |

## Interjúkérdések

1. **Miért nem `await`-eljük az incrementet?** A számláló nem része az üzleti eredménynek. Ha várnánk, egy néma Upstash a request timeoutig (2 s) késleltetné a vásárlást. A `silent` módú teszt ezt bizonyítja.
2. **Mit veszítünk ezzel?** Ha a platform a válasz után megállítja a függvényt, az increment elveszhet. Ezt a `docs/database/index.md` rögzíti, és ezért a számlálót nem szabad döntésre használni.
3. **Miért `unknown` kulcs a `placeOrder` telítettségénél?** A pool-acquire még a hold beolvasása előtt bukik, így az eseményt nem ismerjük. Az `unknown` nem ütközhet UUID-val.
4. **Hogyan teszteltétek a produkciós drótozást mock nélkül?** A valódi context factoryt és a valódi Upstash klienst használjuk, a Postgres valódi, csak az Upstash HTTP végpont helyi fake. A `40001`-et tesztre szűkített trigger váltja ki.
5. **Mi történik, ha az Upstash nincs beállítva?** A foglalás számlálás nélkül lefut, a konfigurációs hibát a lusta függőség egyszer naplózza. Ez döntés, nem véletlen: a foglalás fontosabb a metrikánál (`.devflow/questions.md` megnyitott kérdése).
