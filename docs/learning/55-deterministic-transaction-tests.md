# 55: Determinisztikus tranzakciós tesztek

Ticket: `issues/55-deterministic-transaction-tests.md`; ADR 0005 (row lockok), ADR 0010 (valódi infrastruktúra a tesztekben); lezárt debt: TD-006, TD-016, TD-018, TD-071, TD-076, TD-079.

## Probléma

A lockolást, a pool-telítettséget és a rollbacket vizsgáló tesztek időzítésre épültek: `sleep`, `pg_sleep`, "majd addigra blokkol". Egy lassú gépen ezek flakyk (néha pirosak), gyors gépen pedig akár hamisan zöldek, mert a vizsgált helyzet el sem jön létre. Emellett a tesztek közös, modulszintű klienseken és egymás írásán éltek, így sorrendfüggők voltak.

## Döntés

1. **Postgres-állapotra szinkronizálunk, nem időre.** A `waitForPg` addig pollozza a `pg_stat_activity` / `pg_blocking_pids` nézetet, amíg a feltétel igaz (`packages/booking/src/testing/pg-sync.ts`). Mindig a vizsgált hívással versenyeztetjük (`against`): ha az korán elbukik, azonnal azt dobja és abbahagyja a pollozást, így a korai hiba nem téveszthető össze lassúval. A határidő csak a végtelen várakozást vágja le. A sorrendet latchek (egyszer nyitható kapu), az `occupy` és a `block` (blocker session) adják.
2. **Egyetlen helper modul, subpath exporttal** (`@ticketarena/booking/testing`, soha nem a `src/index.ts`-ből): latch, `occupy`, `block`, `waitForPg`, `withTrigger`, fixture-ök (`NOW`, buyerek, `failureOf`), `bookingTestBed`. Minden tesztfájl ezt használja; nincs fájlonkénti másolat (TD-076). A kliens tesztenként jön létre és `afterEach`-ben záródik (`testing/clients.ts`), nincs modulszintű kliens.
3. **Bizonyítható érvelés a tesztekben.**
   - `occupy` csak akkor oldódik fel, miután a lekérdezése lefutott a tranzakción belül (a pool tényleg tele van; TD-071). Egy teszt késleltetett occupiert injektál, hogy lássa: a hívó a jelre vár.
   - TD-016: a blocker a `pg_blocking_pids` alapján látja, hogy a service blokkolva van, és közvetlenül a `COMMIT` előtt állít be egy flaget. Minden óraolvasás szinkron megkapja a flag aktuális értékét. A lock előtti olvasás a blokkolás előtt történik, tehát a flag előtt; a lock utáni a commit után. A teszt minden snapshot utáni olvasásra elvárja a flaget (`booking-service.test.ts`).
   - TD-018: ha az írások megkezdődtek, majd az outbox insert elbukik (fix `newId` duplikált envelope id-t ad), nem marad hold, claim vagy order, a székek `AVAILABLE`-ök. Újrapróbált kísérletnél egy test-scoped trigger `40001`-et dob az első kísérleten, a másodikon pedig írás után bukik; az elsőnek sem marad nyoma.
   - TD-006: a seat-map és seed tesztek Vitest `sequence.shuffle` mellett is zöldek (`web-shuffled`, `db-shuffled` projekt a `vitest.config.ts`-ekben); minden `SOLD` székhez explicit szék és saját állapot tartozik.
   - TD-079: a buyer-lock race `test.each` esetei azt is ellenőrzik, melyik kérés commitolt előbb. Commit timestamp nem érhető el, ezért az injektált óra olvasási sorrendjét használja: a második kérés csak az első commitja után veheti el a buyer lockot, így az utolsó óraolvasások sorrendje a commit sorrend.

## Alternatívák

| Alternatíva                       | Előny                   | Hátrány                                | Miért nem itt                             |
| --------------------------------- | ----------------------- | -------------------------------------- | ----------------------------------------- |
| `sleep` / `pg_sleep` a sorrendhez | Egyszerű                | Lassú gépen flaky, gyorson hamis zöld  | Nem bizonyít semmit az állapotról         |
| Fájlonkénti helper másolat        | Nincs közös függőség    | Eltérő javítások, TD-076               | Két elutasított kísérlet épp ezért bukott |
| Mockolt DB / óra a lockhoz        | Gyors, determinisztikus | Nem a valódi lock-viselkedést teszteli | ADR 0010: valódi Postgres                 |
| Közös kliens az egész fájlban     | Kevesebb kapcsolat      | Pool-állapot szivárog tesztek között   | Telítési és timeout tesztek eltorzulnának |

## Fogalmak

- **Latch**: egyszer nyitható kapu (promise); a teszt nyitja, nem az óra.
- **`pg_blocking_pids`**: megmondja, mely backend blokkol egy másikat; ebből tudjuk, hogy a service tényleg lockra vár.
- **Pool saturation**: minden kapcsolat foglalt; `occupy` ezt szándékosan idézi elő.
- **Rollback atomicitás**: ha a tranzakció elbukik, egyetlen írása sem marad meg.
- **Deadlock/serialization retry**: ADR 0005 és ticket 54 szerint `40P01`/`55P03`/`40001` után újrapróbálás.

## Mi mehet félre

- Az `occupy` túl korán jelez: a késleltetett occupier tesztje bukik (`testing/occupy.test.ts`).
- A `waitForPg` tovább pollozik elbukott hívás után, vagy határidőn nem nevezi meg, mire várt: `testing/pg-sync.test.ts` (probe-számláló nulla).
- Elnyelt blocker hiba: a `release()` visszadobja; `pg-sync.test.ts`.
- Az óra a lock előtt olvasódik: a TD-016 teszt pirosra vált.
- Az outbox írás tranzakción kívülre kerül, vagy commit az újrapróbálkozások között: a TD-018 tesztek pirosak.
- Sorrendfüggő teszt: a shuffled projekt bukik.
- A sorrendet csak a case címkéje állítja: a TD-079 assertion elkapja, ha a belső sorrend felcserélődik.

## Interjúkérdések

1. **Miért nem `sleep`-pel várunk a blokkolásra?** Az idő nem állapot: a sleep alatt a service lehet, hogy még nem blokkol, vagy már elbukott. A `pg_blocking_pids` pontosan azt mutatja, amire kíváncsiak vagyunk.
2. **Miért kell a `waitForPg`-t a hívással versenyeztetni?** Ha a hívás hibával végez, a feltétel soha nem teljesül, és a teszt a határidőig várna egy félrevezető üzenettel. A versenyeztetés azonnal a valódi hibát adja.
3. **Hogyan bizonyítja a TD-016 teszt, hogy a clock a lock után olvasódik?** A flag csak akkor igaz, ha a blocker már látta a service blokkolását; minden snapshot utáni olvasásnak igaznak kell lennie. Lock előtti olvasás a flag előtt lenne, ezért hamis lenne.
4. **Hogyan bizonyítjuk, hogy retry után sem marad semmi?** Trigger `40001`-et dob az első kísérleten, a másodikon az írások után bukik a tranzakció; ellenőrizzük, hogy nincs hold, claim, és `deadlock_retry` = 1.
5. **Miért közös helper modul, subpath exporttal?** Egy javítás mindenhol érvényes, és a tesztkód nem kerül a production `index.ts`-be.
