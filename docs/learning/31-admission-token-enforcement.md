# 31: Admission token enforcement

Ticket: `issues/31-admission-token-enforcement.md`. ADR: [0008](../adr/0008-waiting-room-admission.md) (és 0002).

## Probléma

A waiting room csak akkor ér valamit, ha a backend is kikényszeríti: ha a `holdSeats` bárkinek működik, aki ismeri az API-t, a queue megkerülhető egy sima HTTP hívással. A felhasználó oldaláról: akit beengedtek, az 30 percig foglalhat; akit nem, az nem. Ugyanakkor a már megszerzett hold fizetését nem szabad megszakítani csak azért, mert az admission közben lejárt.

## Döntés

1. **Aláírt token + Redis revocation együtt.** Az admitted session a következő `queue.status` pollnál kap egy HS256 JWT-t (`sub` = session, `eid` = event, `jti`, `exp` = admittedAt + 30 perc) a `ta_adm_<eventId>` httpOnly cookie-ban (`apps/web/src/server/admission-token.ts`). Az `admittedProcedure` (`trpc.ts`) ellenőrzi az aláírást, az `exp`-et (injektált órával), `sub` = aktuális session, `eid` = `input.eventId`, majd azt, hogy a `jti` még benne van a Redis admitted set-ben. Bármelyik hiba `FORBIDDEN`. Redis-hiba esetén is hibázik (fail closed): ellenőrizetlen admissionnel nem foglalunk helyet.
2. **Csak a `holdSeats` van kapuzva.** A `placeOrder` a hold tulajdonlásából jogosult, így az admission lejárata nem töri meg a fizetést (AT-41).
3. **Minden vevő útja ugyanaz.** A queue lezárta után a `join` az atomi `admitImmediately` Lua scripttel azonnal admittál (`queue-scripts.ts`), így a `join -> status -> token` út akkor is érvényes, ha nincs sor.

Kisebb részletek: az `alg` rögzített (`HS256`), így a token nem választhat algoritmust (pl. `none`); a cookie `HttpOnly; Secure; SameSite=Lax`; az `ADMISSION_SECRET` legalább 32 byte, a `parseServerEnv` validálja; a titkot csak első használatkor oldja fel a kód.

## Alternatívák

| Alternatíva                                 | Előny                  | Hátrány                                           | Miért nem itt                                                                 |
| ------------------------------------------- | ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Csak stateless JWT                          | Nincs Redis lekérés    | Nem vonható vissza `exp` előtt                    | A felszabadult slot admissionjét azonnal vissza kell vonni (ADR 0008)         |
| Csak Redis session-ellenőrzés, token nélkül | Egyszerű, mindig friss | Minden hívás Redis-függő, nincs aláírt bizonyíték | Az ADR tokent ír elő; a token olcsón elutasítja a hamis kéréseket Redis előtt |
| Kliens oldali kapu (UI)                     | Semmi backend munka    | Megkerülhető                                      | A queue-t a backendnek kell kikényszerítenie                                  |
| `placeOrder` is admissionhöz kötve          | Szigorúbb              | Lejárt admission megszakít egy fizetést           | A valid hold elég; ownership dönt                                             |

## Fogalmak

- **JWT (HS256):** aláírt, önleíró token; a szerver a közös titokkal ellenőrzi, adatbázis nélkül.
- **Revocation:** egy már kiadott token érvénytelenítése lejárat előtt; itt a `jti` törlése a Redis admitted set-ből.
- **`jti`:** a token egyedi azonosítója, ez a kulcs a Redis halmazban.
- **Fail closed:** ha az ellenőrzés nem végezhető el (Redis down), a kérés elutasítva marad.
- **httpOnly cookie:** az oldal JavaScriptje nem olvashatja, így XSS nem lopja el.
- **Fix `exp`:** a token nem újul meg; az újrakiadás ugyanazt az `exp`-et adja.

## Mi mehet félre

- Token nélkül, lejárt, más session, más event vagy visszavont `jti`: `FORBIDDEN` (AT-40; `booking.test.ts`: "without an admission token", "expired", "another session's", "another event's", "revoked admission").
- Másik titokkal aláírt token: elutasítva ("signed under another secret").
- Lejárt admission mellett a `placeOrder` működik, a hold nélküli vagy más hold-ja nem (AT-41; `booking.test.ts`, "places an order without admission").
- `admitImmediately` megtartja a meglévő slotot és jti-t (`queue-store-contract.ts`), tehát újracsatlakozás nem duplikál.
- Gyenge titok: a `env.test.ts` az indulásnál elutasítja.

## Interjúkérdések

1. **Miért kell a Redis `jti` ellenőrzés, ha a JWT önmagában hitelesít?** A stateless JWT `exp` előtt nem vonható vissza. Nálunk a slot felszabadulása (leave, reap) azonnal érvényteleníti az admissiont, ezt csak a Redis halmaz tudja.
2. **Mi az ára ennek?** A tokenes előny részben elvész: minden `holdSeats` hívás egy Redis olvasás. Cserébe a kötelező olvasás miatt a Redis-kiesés fail closed, ami a foglalási biztonság szempontjából a helyes irány. (Az ár mérése általános megfontolás, itt nem mértük.)
3. **Miért nincs kapuzva a `placeOrder`?** Mert a hold tulajdonlása már bizonyítja a jogot, és a 30 perces admission lejárta nem szakíthat meg egy folyamatban lévő fizetést (ADR 0008 Scope).
4. **Miért httpOnly és miért rögzített az algoritmus?** HttpOnly: XSS ne tudja kiolvasni a tokent. Rögzített `alg`: a támadó ne tudjon `none`-ra vagy más algoritmusra váltani.
5. **Mi a szerepe az `admitImmediately`-nek?** Ha a queue zárva van, a `join` atomikusan admittál, így egyetlen vevői útvonal létezik, és a `holdSeats` mindig token + `jti` párt vár.
