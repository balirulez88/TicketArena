# 62: Re-join megtartja az élő admissiont

Ticket: `issues/62-rejoin-keeps-a-live-admission.md`; commit: még nincs; ADR: 0008, 0010.

## Probléma

A vásárló már kapott admission slotot, aztán újra hívja a `join`-t (refresh, második tab, kliens retry). Korábban a `join` nem nézte az active set-et, ezért a sessiont újra sorba állította. Amikor a ticker odaért, az admit script új `jti`-t írt a sessionnek, így a vásárló által használt admission érvénytelen lett. A `jti` (az admission token azonosítója) a 31-es ticketben válik tokenné, ezért ennek előtte kellett megoldódnia.

## Döntés

A `JOIN_SCRIPT` (`packages/waiting-room/src/queue-scripts.ts`) első lépésként `ZSCORE`-ral megnézi az `active` set-et. Ha a member slotot tart, `-1`-et ad vissza, és semmit nem ír. Ebből a `QueueStore.join` `{ status: "ADMITTED" }`-et készít (`JoinOutcome`: `QUEUED` vagy `ADMITTED`), a `queue.join` pedig ezt adja a kliensnek.

A helyesség kulcsa az atomicitás. Az ellenőrzés és a sorba írás **egy Lua script**, ezért a ticker nem tud közéjük érni. Külön parancsokkal a `join` látná, hogy nincs slot, a ticker admittálná, és a `join` utána még beírná a sorba: a member egyszerre lenne admitted és queued. A sorrend: előbb a fázis (`NOT_OPEN`/`ACTIVE`/`CLOSED`, 61-es ticket), csak utána a slot. Ezért `ADMITTED` csak nyitott queue-nál jön, a fázison kívüli válaszok nem néznek slotot. A `join` nem heartbeat: a `lastSeenAt` nem változik, a slotot a `status` hívások tartják életben (`.devflow/questions.md`-ben feltételezésként rögzítve, még nincs emberi válasz).

Ha a slot felszabadult (leave, order, reaping), a member nincs az active set-ben, ezért a sor végére áll, mint korábban.

## Alternatívák

| Alternatíva                                     | Előny                               | Hátrány                                                                   | Miért nem itt                                                    |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A service előbb `isActive`-ot hív, aztán `join` | Egyszerű, nem kell script-módosítás | Két round trip, a kettő között a ticker admittálhat (check-then-act race) | Pont az a verseny maradna, amit javítani kell                    |
| Az admit script ne írja felül a meglévő `jti`-t | A ticker oldalán védi az admissiont | A member továbbra is a sorban maradna, foglalná a pozíciót és a rate-et   | A hiba okát (újra sorba állítás) nem szünteti meg                |
| Elosztott lock a session körül                  | Általános, bármilyen műveletre jó   | Plusz hálózati költség, lejárat és lock-kezelés                           | Redis scriptnél a Lua atomicitása ingyen megvan                  |
| Hiba dobása (`ALREADY_ADMITTED`)                | Explicit a kliensnek                | Egy refresh nem hiba; a kliensnek hibát kellene értelmeznie               | Az `ADMITTED` eredmény a már meglévő `status` szerződéshez illik |

## Fogalmak

- **Atomic Lua script**: Redis egyetlen szálon, megszakítás nélkül futtatja, így két parancs között senki nem ír be.
- **Check-then-act race**: ellenőrzés és művelet külön lépés, köztük az állapot megváltozhat.
- **Idempotency**: ugyanaz a `join` többször ugyanazt az eredményt adja, itt `ADMITTED`, mellékhatás nélkül.
- **`jti`**: az admission egyedi azonosítója; ha cserélődik, a régi admission revoked.
- **Contract test**: ugyanaz a tesztcsomag fut minden adapteren, így a viselkedés nem tér el.

## Mi romolhat el

- **Admitted member újra sorba kerül, `jti` cserélődik**: contract test, `join by a member that holds a slot answers ADMITTED...` (`queue-store-contract.ts`): ugyanaz a `jti` marad érvényes további tickek után, egy slot. Fut node-redis és Upstash REST adapteren is.
- **Ticker és join versenye**: `a join racing a ticker on another connection...`, 25 körben külön kapcsolatokon: a végén `{ queued: 0, active: 1 }`.
- **Felszabadult slot után nem lehet újra csatlakozni**: `a member whose slot was freed...` (leave, release, reap után a sor végére áll).
- **A kliens nem kapja meg az eredményt**: `queue.test.ts` `join by an admitted session returns ADMITTED...`, valamint a zod `joinOutput` új ága.
- **A fázis ellenőrzés elmarad**: a service-ben a fázis megelőzi a store hívást (`queue-service.ts`).

## Interjúkérdések

1. **Miért kell egy scriptben lennie az ellenőrzésnek és az írásnak?** Mert külön a ticker beférhet közéjük, és a member admitted és queued lenne egyszerre. A Redis a scriptet megszakítás nélkül futtatja, így az egyik sorrend sem hibás.
2. **Miért `ADMITTED` eredmény és nem hiba?** Refresh vagy retry normális eset, nem hiba. A kliens ugyanazt az `ADMITTED` státuszt kapja, mint a `status`-tól, és nem kell külön ágat kezelnie.
3. **Számít a join heartbeatnek?** Nem. Ha számítana, egy retry-ciklus tartaná életben az elhagyott slotot. A `status` és az admitted hívások tartják életben, a reaper pedig 90 s tétlenség után felszabadítja.
4. **Hogyan bizonyítod, hogy két adapteren is működik?** Az `describeQueueStoreContract` mindkét adapteren lefut, a script és a kulcsok közösek. Csak a script küldése különbözik.
5. **Miért a fázis az első?** Nyitás előtt és zárás után a slotnak nincs jelentése. Az `ADMITTED` válasz csak az aktív ablakban igaz, és a `NOT_OPEN` semmit nem ír.
