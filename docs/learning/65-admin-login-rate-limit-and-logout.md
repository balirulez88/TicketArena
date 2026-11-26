# 65: Admin login rate limit és logout

Ticket: `issues/65-admin-login-rate-limit-and-logout.md`. Commit: még nincs (a `devflow/run-*` ág working tree-je). ADR: nincs új; a meglévő admin limiter és az [ADR 0012](../adr/0012-identity-service-seam.md) identity seam.

## Probléma

Az admin login publikusan elérhető, így a jelszót korlátlanul lehetett találgatni. Az operátornak ráadásul nem volt kijelentkezése: a `ta_admin` cookie 8 óráig élt a böngészőben. A rendszer oldaláról a destruktív admin műveletek (`runRace`, `resetDemo`) már védettek voltak egy globális, 10 másodpercenként 1 kérést engedő limiterrel, a login viszont nem.

## Döntés

1. **A limiter az első lépés** (`apps/web/src/server/identity/admin-login.ts`, `handleAdminLogin`). Minden `POST /api/admin/login` először a `login` actionre kér engedélyt a meglévő admin limitertől, és csak az engedélyezett kísérlet olvassa be a formot és hasonlítja össze a jelszót. A helyes és a hibás jelszó is elhasználja az ablakot, ezért a találgatás a kimenettől függetlenül lassul. A tiltott kísérlet 303-mal a `?error=rate-limited&retry=<mp>` címre irányít, és `Retry-After` fejlécet is küld.
2. **Fail closed.** Ha a limiter nem érhető el vagy rosszul konfigurált, a login el van utasítva (`?error=unavailable`), a hibát pedig naplózza. A `rateLimiter` ezért függvény, amelyet kísérletenként hívunk meg: így a konfigurációs hiba is ugyanabba a `try` ágba esik.
3. **Logout** (`handleAdminLogout`): lejáratja a cookie-t (`Max-Age=0`, ugyanazokkal az attribútumokkal, mint a kiadáskor) és 303-mal a login oldalra irányít. Szerveroldali session store nincs, ezért egy korábban lemásolt cookie a saját 8 órás lejáratáig érvényes marad. Ezt a dokumentáció is kimondja.

## Alternatívák

| Alternatíva                               | Előny                                      | Hátrány                                      | Miért nem itt                                                              |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| Nincs limit                               | Egyszerű                                   | Korlátlan jelszótalálgatás                   | Publikus loginnál elfogadhatatlan                                          |
| IP-nkénti limit                           | Az operátort nem blokkolja idegen          | Megbízható proxy fejléc és több állapot kell | MVP: a meglévő limiter újrahasznosítása (ált. tudás: az IP is hamisítható) |
| Fail open limiter-hibánál                 | Az operátor kiesés közben is belép         | A védelem pont hibánál tűnik el              | A többi admin action is fail closed                                        |
| Szerveroldali session store + visszavonás | A logout tényleg érvényteleníti a cookie-t | Új állapot és infrastruktúra                 | A demóhoz nem éri meg; elfogadott korlát                                   |

## Fogalmak

- **Rate limiter**: időablakonként korlátozza a kérések számát. Itt a `SET admin:rate:login 1 NX PX 10000` Upstash kulcs (a doc szerint) mondja meg, szabad-e a kérés.
- **Fail closed / fail open**: ha a védelem hibázik, tiltunk (closed), illetve engedünk (open).
- **Globális limit**: nincs kliensazonosító, egyetlen ablak van az egész rendszerre. Egy támadó ezzel késleltetheti a valódi admint, ezt a demóban elfogadtuk.
- **Stateless session**: az aláírt cookie önmagában érvényes, a szerver nem tart nyilván semmit, ezért nem vonható vissza.
- **POST-redirect-GET (303)**: a form POST után a böngésző GET-tel követi az átirányítást.

## Mi mehet félre

| Hibamód                                                  | Teszt                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A helyes jelszó is átmegy a limit alatt                  | `admin-login.test.ts`: "every attempt takes the admin limit... even the right password is refused within 10 s" (valódi Upstash, `PTTL` ellenőrzés) |
| Tiltott kísérlet cookie-t állít be vagy jelszót hasonlít | ugyanez a teszt: nincs `set-cookie`, a `retry` 1 és 10 között van                                                                                  |
| A limiter kiesésekor beengedi a login                    | "an unreachable limiter refuses the login" és "a limiter that cannot be configured..."                                                             |
| A route nem a limitert használja                         | `login/route.test.ts`: elérhetetlen limiter mellett a helyes jelszó is `unavailable`                                                               |
| Logout után az admin procedure még működik               | `logout/route.test.ts`: cookie jar szimulációval `admin.snapshot` -> `UNAUTHORIZED`                                                                |
| A hibás query paraméter hibaüzenetet tör                 | `admin.test.tsx`: ismeretlen `error` nem mutat hibát, a rossz `retry` `null`                                                                       |

## Interjúkérdések

1. **Miért a limiter a jelszó-összehasonlítás előtt van?** Így a tiltott kísérlet semmit sem árul el a jelszóról, és a hibás és a helyes próbálkozás ugyanúgy költséges. Az `admin-login.ts` ezt a sorrendet rögzíti.
2. **Mi a globális limit hátránya?** Egy támadó 10 másodpercenként egy kéréssel folyamatosan foglalhatja az ablakot, így a valódi admin belépése késik. A demóban ezt elfogadtuk, és dokumentáltuk, a per-IP megoldás megbízható proxy fejléceket és állapotot igényelne.
3. **Miért fail closed?** Limiter nélkül nincs korlát a találgatásra, ezért a kiesés nem nyithat kaput. Az operátor kellemetlensége (átmenetileg nem tud belépni) kisebb kár, mint a védelem megkerülése.
4. **Mit tud és mit nem a logout?** Törli a cookie-t abban a böngészőben, ezért onnantól az admin procedure `UNAUTHORIZED`. Egy lemásolt cookie-t nem vonhat vissza, mert nincs szerveroldali állapot. Csak a `SESSION_SECRET` cseréje érvénytelenít mindent.
5. **Miért plain form és 303?** A login és a logout is HTML form, hidratáció nélkül is működik, és a 303 miatt a böngésző GET-tel követi az átirányítást, így az újratöltés nem küldi újra a POST-ot.
