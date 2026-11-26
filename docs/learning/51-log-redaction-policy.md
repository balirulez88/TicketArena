# 51: Log redaction policy

Ticket: `issues/51-log-redaction-policy.md`. Commit: még nincs (munkafában). ADR: nincs; a TD-048 bejegyzés a `docs/technical-debt.md`-ben, a policy a `docs/architecture` „Logging and ids” szakaszában.

## Probléma

Egy handler vagy tRPC procedure hibája gyakran tartalmazza a vevő e-mail-címét és telefonszámát (például egy query argumentuma az üzenetben vagy a stackben). Ha a hibát egészében naplózzuk, a személyes adat a logba kerül, és a log sokkal szélesebb körben olvasható, mint az adatbázis. Telepítés előtt (ticket 38) ezt le kell zárni.

## Döntés

1. **Redaction a kiírás előtti utolsó ponton.** A `redactLogLine` (`packages/contracts/src/log-redaction.ts`) a pino `hooks.streamWrite` horgára kerül mindkét appban (`apps/web/src/server/logger.ts`, `apps/worker/src/logger.ts`). Ez már a _serializált sort_ kapja, így lefedi a child binding-okat, a mezőket és a serializált error-t is, akárki naplózta. Nem kell minden hívási helyen emlékezni rá.
2. **Két szabály, mert külön-külön nem elég.** Kulcs alapján (`/e-?mail|phone|recipient/i`) a strukturált mezők értéke `[Redacted]` lesz, bármilyen mélyen, tömbben is. Alak alapján (e-mail regex, 7+ számjegyű sor) a szabad szövegben, például error message-ben és stackben lévő adat tűnik el. A telefonregex szándékosan túlredaktál, de UUID-k, ISO időbélyegek és IP-címek épek maradnak (`log-redaction.test.ts`).
3. **A tRPC hibák is a loggeren át mennek.** A `logProcedureError` a teljes hibát (`err`) a redaktáló loggerrel írja, nem `console`-ra, amelyet semmilyen policy nem fed le.

A kulcsötlet: a védelem a _kimenetnél_ van, nem a bemeneteknél, ezért egy új naplózó hívás sem kerülheti meg.

## Alternatívák

| Alternatíva                               | Előny                            | Hátrány                                                            | Miért nem itt                                                           |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| pino `redact` útvonalakkal                | Beépített, gyors                 | Csak ismert útvonalakat fed; a stackbe ágyazott szöveget nem       | A TD-048 pont a hibaüzenetbe ágyazott adat (általános tudás a pino-ról) |
| Hívási helyen kézzel kihagyni a contactot | Egyszerű, semmi magic            | Egyetlen felejtés szivárog; a teljes error naplózását tiltani kéne | Nem skálázódik, nem bizonyítható                                        |
| Csak kulcs alapú redaction                | Pontos, kevés false positive     | Szabad szövegben lévő e-mail/telefon átcsúszik                     | A hiba üzenete szöveg, nem mező                                         |
| Log pipeline szűrő (a log gyűjtőben)      | Egy hely, nem kell alkalmazáskód | A nyers adat már elhagyta a processzt, és a stdout-on olvasható    | Általános megközelítés; itt az app-oldali garancia erősebb              |

## Fogalmak

- **PII (személyes adat)**: itt a vevő e-mailje és telefonszáma; nem szabad a logba kerülnie.
- **Redaction**: az érték cseréje `[Redacted]`-re kiírás előtt.
- **`streamWrite` hook**: pino hook, amely a kész, serializált sort átírhatja a kiírás előtt.
- **Serializált error**: a pino az `err` objektumot JSON-má alakítja (`type`, `message`, `stack`); a szövegmezőkben lehet adat.
- **Túlredaktálás**: inkább törlünk egy ártatlan számot, mint hogy egy telefonszám kiszivárogjon.

## Mi romolhat el

| Hiba                                                         | Teszt                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer handler hibája e-mailt/telefont ír a logba (TD-048) | `apps/worker/src/log-redaction.test.ts`: „TD-048: a handler error carrying…” (a név és a korrelációs id megmarad, a contact nem)          |
| tRPC procedure hiba szivárogtat                              | `apps/web/src/server/logger.test.ts`: „a tRPC procedure error carrying…” (név, path, id megmarad)                                         |
| Strukturált mező vagy binding szivárog                       | `log-redaction.test.ts` (worker): „redacts contact fields in bindings and fields…”; contracts: „by key at any depth, including in arrays” |
| Szabad szövegbe ágyazott adat (message, stack)               | `packages/contracts/src/log-redaction.test.ts`: „embedded in any string…”                                                                 |
| A redaction elrontja az id-kat, időbélyegeket                | ugyanott: „keeps ids, timestamps, addresses and numbers intact”                                                                           |
| Nem JSON sor megkerüli a szűrőt                              | ugyanott: „even in a line that is not JSON”                                                                                               |

Nyitott: a ticket utolsó pontja (TD-048 `RESOLVED` a `docs/technical-debt.md`-ben) még nincs kipipálva.

## Interjúkérdések

1. **Miért a serializált soron redaktáltok, és nem a hívási helyeken?** A hívási helyek száma nő, és egy felejtés szivárog. A `streamWrite` hook minden sort lát, így az error-ba és a binding-okba ágyazott adatot is elkapja.
2. **Miért kell kulcs és alak szerinti szabály is?** A kulcs a strukturált mezőket fedi (`contactEmail`, `recipient`), de egy error message-be ágyazott e-mailnek nincs kulcsa. Az alak szerinti regex ezt kapja el, ára a néha túlzott törlés.
3. **Mi a hátránya a regexnek?** False positive: egy 7+ számjegyű szám is telefonnak számít. Ezért kizártuk a szóhoz vagy kötőjelhez tapadó számsorokat (UUID, ISO dátum), és a pontot nem tekintjük elválasztónak (IP, verzió).
4. **Miért kellett a tRPC `onError`-t átkötni?** Korábban a hibák `console`-ra mehettek, amelyet nem véd a policy. A `logProcedureError` a teljes hibát a redaktáló loggerrel írja.
5. **Hogyan bizonyítjátok, hogy a hibanév és a korrelációs id megmarad?** A két TD-048 teszt valódi hibát naplóz egy buffer-célba, és a kimeneti sorra állítja: megvan a név, a path és az id-k, de nincs benne az e-mail és a telefon.
