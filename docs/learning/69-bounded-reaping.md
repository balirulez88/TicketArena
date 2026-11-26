# 69: Korlátos reaping az aktív slotokon

Ticket: `issues/69-bounded-reaping.md`; commit: még nincs; ADR: 0008 (az admission és a slot egy lépésben szabadul fel); a batch méret kérdései: `.devflow/questions.md`.

## Probléma

A reaper 15 másodpercenként felszabadítja a tétlen vagy lejárt admissionű slotokat. A régi `REAP_SCRIPT` az egész `active` halmazt végigjárta egyetlen Lua hívásban. A Redis egy scriptet atomikusan, megszakítás nélkül futtat, ezért amíg az fut, az esemény többi queue művelete és admission ellenőrzése áll. Amíg a queue nyitva van, a `maxActive` korlátozza a halmazt. Zárás után viszont az azonnali admission megkerüli a `maxActive`-et, így a halmaz minden, az elmúlt 90 másodpercben látott vevőt tartalmaz, és a script futási ideje vele nő.

## Döntés

1. **Egy hívás legfeljebb `batchSize` jelöltet vizsgál** (`packages/waiting-room/src/queue-scripts.ts`, `REAP_SCRIPT`). A jelölteket nem szkenneléssel, hanem a két rendezett indexből veszi: először a tétlen slotokat (`ZRANGEBYSCORE active` a `lastSeenAt` alapján, `LIMIT`-tel), a batch maradékában a lejárt `jti`-ket (`ZRANGEBYSCORE admitted` a lejárat alapján). A válasz `{ freed, more }`; a `more` két `LIMIT 1` próbából jön, megszámlálás nélkül.
2. **Új `holders` hash** (`jti` → session id, az `admission` fordítottja). Egy lejárt `jti`-ből ezzel jutunk el a felszabadítandó slothoz teljes szkennelés nélkül. Minden script, amely `admission` bejegyzést ír vagy töröl, ugyanabban a lépésben a `holders`-t is karbantartja. A slot felszabadítása és a `jti` visszavonása továbbra is egy lépés (AT-39).
3. **Az ismétlés a service-ben él** (`queue-service.ts`, `QueueService.reap`): legfeljebb `REAP_BUDGET.maxBatches` (50) hívás, egyenként 100 jelölttel, amíg `more` hamis. A hívások között más műveletek is lefuthatnak. Minden hívás önmagában atomikus, így egy közben heartbeatelt vagy újra admittált slotot az új állapota alapján ítél meg.

A kulcsötlet: az atomicitás és a korlátos futásidő ellentmond egymásnak egy nagy halmazon, ezért sok kicsi atomikus lépésre bontjuk, és a hívások között a Redis szabad.

## Alternatívák

| Alternatíva                                        | Előny                              | Hátrány                                                            | Miért nem itt                                      |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Marad az egy nagy script                           | egyszerű, egy atomikus pillanatkép | a futásidő a halmazzal nő, blokkolja az admission ellenőrzéseket   | pont ez volt a review kifogása (PR #12)            |
| `SCAN`-nel kliensoldali lapozás külön parancsokkal | nincs hosszú script                | a slot felszabadítása és a `jti` visszavonása nem lenne egy lépés  | sérülne az AT-39 / ADR 0008                        |
| `maxActive` érvényesítése azonnali admissionnél is | a halmaz korlátos maradna          | az azonnali admission viselkedése változna                         | a ticket szerint az azonnali admission marad       |
| Lejárat szerinti index nélkül, csak tétlenség      | nincs `holders` hash               | a lejárt admissionű, de aktív slot a következő 90 s tétlenségig él | a lejárt admissionnek azonnal fel kell szabadulnia |

## Fogalmak

- **Atomic script**: a Redis egy Lua scriptet más parancs közbeékelődése nélkül futtat. Ez ad helyességet, de a hosszú script mindenki mást blokkol.
- **Sorted set (ZSET) és `LIMIT`**: pontszám szerint rendezett halmaz; a `ZRANGEBYSCORE ... LIMIT` csak a következő néhány elemet olvassa, nem az egészet.
- **`jti` revocation**: az admission token azonosítójának törlése az `admitted` halmazból; ezután a token érvénytelen (ADR 0008).
- **Batch és pass budget**: a hívás mérete (`batchSize`), illetve a hívások száma egy körben (`maxBatches`); a maradék a következő körre vár.

## Mi romolhat el

- **Egy hívás sok slotot szabadít fel és blokkol**: a contract teszt (`queue-store-contract.ts`, "one reap call frees at most the batch size...") mindkét adapteren (valódi Redis és Upstash-kompatibilis) bizonyítja, hogy egy hívás legfeljebb 2 slotot szabadít fel, `more: true`-val.
- **Valami kimarad, vagy többet törlünk a kelleténél**: ugyanez a teszt ismételt hívásokkal pontosan az m1-m7 slotot szabadítja fel, az érvényes admissionű, aktív m8 és m9 megmarad, a `jti`-k visszavonása stimmel.
- **A reaper pass nem áll meg**: `queue-service.test.ts`, "one reap pass repeats bounded store calls...": `batchSize: 2, maxBatches: 2` mellett 5 slotból 4 szabadul fel, 1 a következő körre marad.
- **Felszabadított slot él tovább érvényes `jti`-vel**: a meglévő reaper tesztek (`isAdmitted` hamis a felszabadítás után) zöldek maradtak.
- Ismert kompromisszum (`.devflow/questions.md`): a deploy előtti slotokhoz nincs `holders` bejegyzés, ezért a lejárt `jti`-jük elvész, és a slot csak 90 s tétlenség vagy re-join után szabadul fel.

## Interjúkérdések

1. **Miért nem hagyható az egész halmazt bejáró script?** Mert a Redis scriptje atomikus és blokkoló, és zárás után a halmaz nem korlátos (az azonnali admission megkerüli a `maxActive`-et). A futásidő a vevők számával nő, közben az admission ellenőrzések állnak.
2. **Hogyan lesz a bejárásból korlátos munka?** A jelölteket rendezett indexekből, pontszám szerint, `LIMIT`-tel vesszük, nem szkenneljük az egészet. A `more` két `LIMIT 1` próbából adódik.
3. **Miért kell a `holders` hash?** A lejárat az `admitted` ZSET-ben `jti` szerint indexelt, de a felszabadítandó slot session id szerinti. A `holders` a híd a kettő között, és minden `admission`-t író script szinkronban tartja.
4. **Mi történik, ha egy slot a batch-ek között változik?** Minden hívás atomikus, és az aktuális állapotot nézi, így az újra admittált slot nem szabadul fel tévesen. Ezt a design adja, külön teszt nincs rá.
5. **Mi a kompromisszum a pass budgettel?** Egy kör eventenként legfeljebb 5 000 slotot szabadít fel, a maradék a következő 15 s-os körre vár. Cserébe a blokkolás hívásonként korlátos.
