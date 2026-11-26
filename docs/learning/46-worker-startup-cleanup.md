# 46: Worker indítás és leállítás takarítása

Ticket: `issues/46-worker-startup-cleanup.md`. Commit: még nincs (munkafában). ADR: [0013](../adr/0013-deployment-topology.md) (worker topológia); a TD-034 és TD-035 bejegyzés a `docs/technical-debt.md`-ben.

## Probléma

Ha a worker health portja foglalt, a `startWorker` korábban már elindította a relay-ket és a consumer runnereket, aztán elbukott. A hívó lezárta a buszt és az adatbázist, a ciklusok pedig tovább dolgoztak a lezárt erőforrásokon. A leállításnál a fordított gond volt: egy `stop()` hiba kezeletlen rejectet okozott, egy be nem fejeződő stop pedig örökre megakasztotta a kilépést.

## Döntés

1. **Először a port, aztán a ciklusok.** A `listen` (`worker.ts`) az indítás elején köti a health portot, és a hibát a port nevével rejecteli. Foglalt portnál még nincs mit takarítani. A `startLoops` közben minden ciklus a `StartedLoops` tömbjébe kerül, amint elindult. Ha egy későbbi lépés elbukik (pl. egy consumer `subscribe`-ja), a `catch` mindent leállít, ami már fut, és csak utána dobja tovább a hibát. A `Promise.allSettled` miatt minden subscribe befejeződik a hiba továbbterjedése előtt, így nem indul runner a takarítás után.
2. **Fázisos, hibatűrő leállítás.** A `stopPhases` (`lifecycle.ts`) a fázisokat egymás után, a fázis tagjait párhuzamosan állítja le. Soha nem rejectel: a hibákat összegyűjti, így egy hibás `bus.close()` után a `prisma` még lezáródik.
3. **Korlát (deadline).** A `stopWithin` a leállítást `Promise.race`-be teszi egy időzítővel (`DEFAULT_SHUTDOWN_DEADLINE_MS` = 25 s, a Fly 30 s-os `kill_timeout`-ja alatt, felülírható `deadlineMs`-sel). A határidőnél naplózza, mely komponensek függnek még, és 1-gyel lép ki. A relay tick claim tranzakciója ilyenkor commit nélkül szakad meg, a Postgres visszagörgeti, a sorok `PENDING` maradnak (a `lifecycle.ts` kommentje szerint).

A kulcsötlet: a `process.exit` és az idő a határ, ezért injektáljuk (`exit`, `deadlineMs`), és a `main.ts` csak a `startWorkerProcess`/`shutdownWorkerProcess` függvényeken át indít és állít le.

## Alternatívák

| Alternatíva                                   | Előny                    | Hátrány                                                          | Miért nem itt                                                                                                   |
| --------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `process.on("unhandledRejection")` globálisan | Egy helyen elkap mindent | Nem takarít, csak jelez; a futó ciklusok megmaradnak             | A ticket azt kéri, hogy semmi ne fusson a hiba után                                                             |
| Az `await server.listen` marad a végén        | Kisebb diff              | Foglalt portnál a ciklusok már futnak, takarítani kell           | A port korai kötése megszünteti a problémát a gyökerénél                                                        |
| `Promise.all` a subscribe-oknál               | Egyszerűbb               | Az első hiba után más subscribe még elindíthat runnert           | `allSettled` kell, hogy a takarítás után ne induljon semmi                                                      |
| Leállítás határidő nélkül                     | Nincs időzítő            | Függő stop esetén a worker nem lép ki, a Fly kényszerből öli meg | A határidő naplózza, mi akadt el, és tiszta kilépési kódot ad (általános megközelítés: SIGKILL-lel nincs napló) |

## Fogalmak

- **Graceful shutdown**: SIGTERM után a folyamat rendezetten leállítja a munkáját, mielőtt kilép; az orchestrator (itt Fly) egy idő után SIGKILL-t küld.
- **Fázisos leállítás**: a függőségek fordított sorrendben záródnak (előbb a ciklusok, aztán a busz, Redis, Prisma), hogy egy ciklus ne dolgozzon lezárt erőforráson.
- **Claim tranzakció**: a relay egy tranzakcióban foglalja le az outbox sorokat; megszakadáskor a Postgres visszagörgeti, a sorok `PENDING` maradnak.
- **Dependency injection a process határán**: az `exit` függvény paraméter, így a teszt rögzíti a kilépési kódot, és nem állítja le a tesztfolyamatot.

## Mi romolhat el

| Hiba                                                           | Teszt                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Foglalt portnál a relay/runner tovább publikál vagy fetch-el   | `worker-startup.test.ts`: „rejects naming a health port that is in use…" (300 ms csend alatt a számlálók nem nőnek, a sor `PENDING`) |
| Későbbi lépés hibája után a már elindult ciklusok futnak       | ugyanott: „stops the relay and the runners already started…" (egy consumer subscribe-ja elutasít, utána nincs aktivitás)             |
| Elbukott indításnál kezeletlen kivétel, nincs kilépési kód     | `lifecycle.test.ts`: „turns a failed start into a logged error…" (`worker failed to start`, erőforrások zárva, kód 1)                |
| Hibás stop után a többi komponens nyitva marad, nincs naplózás | ugyanott: „logs a component whose stop rejects…" (`prisma` még leáll, kód 1)                                                         |
| Be nem fejeződő stop miatt a worker nem lép ki                 | ugyanott: „exits non-zero at the deadline…" (`pending: ["relay:booking"]`, kód 1, 20 ms határidővel, nincs fix sleep)                |

Nyitott: a TD-034/TD-035 bejegyzéseket nem írták át (a CLAUDE.md fagyasztja a regisztert), ezért a ticket utolsó pontja nyitott. A 25 s értéket a futás maga feltételezte, jóváhagyásra vár (`.devflow/questions.md`).

## Interjúkérdések

1. **Miért kötjük a portot az első lépésben?** Ha a bind az első, ami elbukhat, foglalt portnál még semmi nem fut, nincs mit visszagörgetni. A későbbi hibákra külön `catch` állítja le a már elindultakat.
2. **Miért nem rejectel a `stopPhases`?** Egy hibás komponens nem akadályozhatja a későbbiek lezárását (busz, adatbázis pool). A hibákat gyűjti, a hívó dönt: a `startWorker` AggregateError-t dob, a shutdown naplóz és 1-gyel lép ki.
3. **Mi történik a félbeszakadt relay tickkel a határidőnél?** A claim tranzakció nincs commitolva, a kilépéssel a kapcsolat megszűnik, a Postgres visszagörgeti, a sorok `PENDING` maradnak. Nincs elveszett esemény, legfeljebb újrapublikálás, amit az idempotens consumerek kezelnek.
4. **Hogyan teszteltétek az időkorlátot sleep nélkül?** A `deadlineMs` injektált (20 ms), a komponens stop-ja sosem teljesülő Promise. Ha a határidő hiányozna, a teszt a 2 s-os timeoutjába futna.
5. **Miért 25 s?** A Fly 30 s után SIGKILL-t küld, 25 s-nál még marad idő naplózni, mi akadt el. Ez a projekt döntése, nem mért érték.
