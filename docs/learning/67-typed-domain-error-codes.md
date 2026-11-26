# 67: Típusos domain hibakódok a kliensnek

Ticket: `issues/67-typed-domain-error-codes.md` · commit: még nincs (`devflow/run-202611241838` ág) · előzmény: a ticket 33 `.devflow/questions.md`-ben rögzített, ideiglenesnek elfogadott döntése (hibaüzenet-parsolás)

## Probléma

A `SEAT_UNAVAILABLE` és a `LIMIT_EXCEEDED` is tRPC `CONFLICT`-ként érkezett, ezért a hold UI a hibaüzenet elejéből olvasta ki a domain kódot, a foglalt székek id-jét pedig a szöveg vesszős listájából. Ugyanígy a checkout UI az `IDEMPOTENCY_KEY_REUSED` és a `HOLD_EXPIRED` előtagot. Ez törékeny: egy üzenet átfogalmazása csendben elrontja a UI-t, és a fordító sem szól.

## Döntés

- A routerek eddig is a domain hibát adták a `TRPCError` `cause`-ának. Az új `domainErrorData` (`server/domain-error-data.ts`) egy **explicit listán** (13 booking hibaosztály, köztük az admin reset `RESET_BLOCKED` és `NOT_DEMO_EVENT` kódja) nézi meg, hogy a `cause` ismert domain hiba-e. Ha igen, `{ domainCode }`-ot ad vissza, `SEAT_UNAVAILABLE`-nél `seatIds`-szal együtt.
- A `server/trpc.ts` `errorFormatter`-e a `data`-t **mezőnként** építi: `code`, `httpStatus`, `path`, és a domain mezők. A tRPC alapértelmezése fejlesztői módban a szerver stacket is beteszi a `data`-ba; ez így soha nem kerül a böngészőbe, a route `onError`-ja logolja.
- `INTERNAL_SERVER_ERROR` soha nem kap `domainCode`-ot: ha egy domain hiba leképezés nélkül szökik ki, az hiba a kódban, nem a kliensnek szóló válasz.
- A kliens `error.data.domainCode` típusa az `AppRouter`-ből kikövetkeztetett unió, így a `hold-failure.ts` és a `checkout-failure.ts` `switch`-e típusellenőrzött; elgépelt kódnál a `tsc` hibát ad. Üzenetet egyik sem olvas.
- A tRPC kód és az emberi üzenet változatlan, más hívók nem törnek el.

## Alternatívák

| Alternatíva                                      | Előny                            | Hátrány                                                 | Miért nem itt                                                      |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Üzenet-parsolás (előző állapot)                  | Nincs szerveroldali munka        | Szövegfüggő, a típusrendszer nem védi                   | Pont ezt váltja ki a ticket                                        |
| Minden domain hibának saját tRPC kód             | Nincs extra mező                 | A tRPC kódkészlete zárt, kevés `CONFLICT`-szerű kód van | `SEAT_UNAVAILABLE` és `LIMIT_EXCEEDED` természeténél fogva ütközés |
| Bármely `cause.code` továbbítása                 | Nincs lista, új hiba automatikus | Prisma (`P1001`) vagy Redis kód is kiszivárogna         | Belső részlet nem mehet a `data`-ba; az explicit lista biztonságos |
| A tRPC default `data` spread-elése, stack nélkül | Kevesebb kód                     | Egy későbbi tRPC verzió új mezője automatikusan kimenne | Mezőnkénti építés: csak az megy ki, amit kimondtunk (feltételezés) |

## Fogalmak

- **Error formatter**: a tRPC hook, amely a szerver hibából a drótra kerülő `shape`-et építi; a `data` típusa ebből jut el a klienshez.
- **Domain code**: egy booking elutasítás kódja (`SEAT_UNAVAILABLE`, ...) a `data.domainCode`-ban (lásd `docs/glossary.md`).
- **`cause`**: a `TRPCError` eredeti hibája; itt ez hordozza strukturáltan a domain kódot és a székeket.

## Mi mehet félre

| Hibamód                                               | Teszt                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Egy leképezett domain hiba kód nélkül érkezik         | `error-data.test.ts`: `a mapped %s carries its domain code` (mind a 13), és `booking.test.ts`: `booking refusals on the wire ...` |
| `SEAT_UNAVAILABLE` székek nélkül                      | `SEAT_UNAVAILABLE carries the taken seat ids` (formatter és valódi router)                                                        |
| Nem domain hiba vagy infrastruktúra-`cause` kódot kap | `an error that is not a domain error carries no domain code`, `a refusal that is not a domain error carries no domain code`       |
| Stack vagy belső részlet a `data`-ban                 | `data holds only the tRPC code, status, path and domain fields: never a stack or a cause`                                         |
| A UI mégis az üzenetből dönt                          | A UI tesztek `"Refused"` üzenettel futnak; a kód nélküli, de `SEAT_UNAVAILABLE: ...`/`HOLD_EXPIRED: ...` üzenet általános hiba    |

A tesztek a valódi fetch handleren át hívják a routert (`server/testing/wire-client.ts`), így a formatter is fut; csak a hálózat van kiváltva.

## Interjúkérdések

1. **Miért nem elég a tRPC kód?** A kódkészlet zárt és durva; két különböző elutasítás (foglalt szék, vevői limit) ugyanaz a `CONFLICT`. A UI-nak a domain jelentés kell.
2. **Miért explicit lista, és nem bármely `code` mező?** Mert a `cause` lehet Prisma vagy Redis hiba is saját kóddal; ami nincs a listán, az belső részlet és nem mehet ki.
3. **Hogyan lesz típusbiztos a kliens?** A formatter visszatérési típusa az `AppRouter` hibashape-jének része, a `TRPCClientErrorLike<AppRouter>` innen ismeri a `domainCode` unióját.
4. **Miért nincs stack fejlesztői módban sem?** A különbség dev és prod között maga is kockázat (rossz `NODE_ENV`); a stack a szerver logban megvan.
