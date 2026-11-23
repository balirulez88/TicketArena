# 63: Redis kiesése nem akasztja meg a foglalást és a workert

Ticket: `issues/63-redis-outages-do-not-hang-booking-or-the-worker.md`. ADR: [0008](../adr/0008-waiting-room-admission.md) (amendment), [0005](../adr/0005-postgres-seat-state-row-locks.md) (a székek állapota Postgresben).

## Probléma

A Redis csak a queue sorrendjét és az admissiont dönti el, a székek állapotát soha (ADR 0005). Mégis a worker `await redis.connect()`-tel indult, így Redis nélkül a relay, a consumerek és a sweeper sem futott. A webes oldalon a lecsukott Redis lógó queue hívásokat és a `placeOrder` best-effort slot felszabadításának megakadását okozhatta. A vevő számára: egy mellékrendszer kiesése nem állíthatja meg a fizetést.

## Döntés

1. **A worker nem várja meg a Redist.** A relay, a consumerek és a sweeper azonnal indul; az admission ticker és a reaper kudarcos passzt naplóz, és újrapróbál. A `/health` külön jelzi a Redist (`apps/worker/src/main.ts`, `redis.ts`).
2. **Korlátos, lusta kapcsolat.** `createLazyConnection` (`packages/waiting-room/src/lazy-connection.ts`): az első használatkor csatlakozik, a connectnek és minden parancsnak saját határideje van, a kliens `disableOfflineQueue`-val nem sorba állítja a parancsokat. Az első sikertelen connect után a klienst destroy-olja, és a következő híváskor újat épít. Saját command deadline kell, mert a node-redis command timeoutja leáll, miután a parancsot kiírták a socketre (a kód kommentje és `.devflow/questions.md`).
3. **Fail open, de csak a revocationre.** Az `admittedProcedure` (`trpc.ts`) mindig ellenőrzi az aláírást, a HS256-ot, az `exp`-et, a `sub`-ot és az `eid`-et. Csak ha a Redis elérhetetlen (`RedisUnavailableError`: nincs kapcsolat vagy nincs válasz időben), akkor hagyja ki a `jti` lekérdezést, és warningot naplóz (eventId, soha nem a token). Egy Redis error reply (pl. hibás parancs) továbbra is hiba: a szerver válaszolt, tehát fail closed. A queue procedure-ök `SERVICE_UNAVAILABLE`-t adnak, és kiesés alatt nem jön létre új admission.

**Elfogadott kockázat:** kiesés alatt egy visszavont token az `exp`-ig (legfeljebb 30 perc) használható marad. A székek helyessége ettől nem függ, mert a hold és a rendelés Postgresben dől el. Ez az ADR 0008 amendmentjében is szerepel.

## Alternatívák

| Alternatíva                                 | Előny                               | Hátrány                                                     | Miért nem itt                                               |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Fail closed (ticket 31 eredeti viselkedése) | Soha nincs ellenőrizetlen admission | Redis kiesés alatt senki nem foglalhat                      | Egy mellékrendszer lenne a foglalás egyetlen hibapontja     |
| Mindent átengedni kiesés alatt              | Egyszerű                            | Hamis vagy lejárt tokenek is bejutnak                       | A token ellenőrzése Redis nélkül is olcsó, így maradjon meg |
| Csak a node-redis `commandTimeout`          | Nem kell saját kód                  | A kiírt parancs után nem számol; hung Redis lógatja a hívót | A `silent` módú teszt pont ezt bizonyítja                   |
| Offline queue + végtelen retry              | Nincs elveszett parancs             | Hívások halmozódnak, memória és késleltetés nő              | Gyors hibát akarunk, nem várakozást                         |

## Fogalmak

- **Fail open / fail closed:** hiba esetén átenged, illetve megtilt. Itt csak az egy ellenőrzés (revocation) fail open.
- **Deadline vs. timeout:** a saját `Promise.race`-alapú határidő a kliens belső időzítésétől függetlenül biztosítja a visszatérést.
- **Offline queue:** a kliens a lecsatlakozott idő alatt puffereli a parancsokat; kikapcsolva azonnal hibázik.
- **Destroy-and-replace:** a nem válaszoló kapcsolatot eldobjuk, hogy a későbbi parancsok ne sorakozzanak az elveszett válasz mögé.
- **Stand-in:** valódi TCP listener a Redis előtt (`packages/test-infra/src/redis-stand-in.ts`) `forward`, `silent` és `closed` móddal.

## Mi romolhat el

| Hiba                                                                             | Teszt                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A worker Redis nélkül nem indít relayt, sweepert; a ticker nem tér magához       | `apps/worker/src/redis-outage.test.ts`                                         |
| Hung Redis lógatja a `/health`-t vagy a klienst                                  | ugyanott, `/health answers within a bounded time` és a bounded-client teszt    |
| Connect/command határidő nélkül lóg, a kliens nem cserélődik                     | `lazy-connection.test.ts`                                                      |
| `placeOrder` Redis hiba miatt elakad vagy elbukik                                | `routers/redis-outage.test.ts`, `placeOrder commits ... within a bounded time` |
| Rossz aláírás, `none`/HS384, lejárt, másik session vagy event átjut kiesés alatt | ugyanott, a hat negatív eset                                                   |
| Elérhető Redisnél a hiányzó vagy visszavont `jti` átjut                          | `with Redis reachable, the revocation lookup decides`                          |
| Kiesés alatt új admission születik                                               | `no new admission is issued`                                                   |

A kiesést valódi TCP stand-innel teszteljük, nem mockkal: a mock nem tudja megmutatni, hogy a kiírt parancs után a node-redis elhallgat.

## A PR-review két HIGH hibája és a javításuk

- **Handshake alatti error reply:** a hibás jelszó (`WRONGPASS`) korábban kiesésnek számított, így a revokáció-ellenőrzés kimaradhatott. Most a handshake hibaválasza is változatlanul továbbmegy, és a kapu zárva marad.
- **Elakadt reconnect:** a node-redis saját reconnectje csak a TCP connectet korlátozta, a handshake-et nem, így a kliens örökre offline maradhatott. Most a node-redis nem reconnectel. A lazy connection eldobja a nem kész klienst, és újat épít a connect-határidő alatt.

## Interjúkérdések

1. **Miért nem fail closed, ha biztonsági kapuról van szó?** A kapu a sorrendet védi, a székeket a Postgres. A fail closed itt az egész foglalást leállítaná, a fail open pedig legfeljebb egy visszavont tokent enged 30 percig. Az érvényesség többi ellenőrzése (aláírás, alg, exp, sub, eid) nem lazul.
2. **Miért kell saját command timeout?** A node-redis timeout leáll, ha a parancs már a socketen van. A `withDeadline` ezt lefedi, és a kliens eldobásával a lecsúszott válasz nem blokkolja a következő parancsokat.
3. **Hogyan különbözteted meg a kiesést a Redis válaszától?** `ErrorReply` = a szerver válaszolt, ezt változatlanul dobjuk (fail closed). Minden más hiba `RedisUnavailableError`. A `false` válasz sosem kiesés.
4. **Miért stand-in a mock helyett?** A hibamódok (refused, néma, megszakadt) a TCP szintjén élnek. A projekt szabálya is, hogy a saját modulokat nem mockoljuk.
5. **Mi marad kockázat?** A kiesés alatt visszavont token 30 percig él. Ez tudatosan vállalt kockázat.
