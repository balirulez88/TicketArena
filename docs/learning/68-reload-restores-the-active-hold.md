# 68: Az oldalújratöltés visszaállítja az aktív holdot

Ticket: `issues/68-reload-restores-the-active-hold.md`; commit: még nincs; ADR: nincs ehhez a jegyhez (a 33-as jegy válasza: `.devflow/questions.md`).

## Probléma

A vevő hold alatt újratölti az event oldalt, és a hold eltűnik: csak a `holdSeats` mutation eredményében élt a kliensen. A székek közben akár 10 percig foglaltak maradnak, és beleszámítanak a vevői limitbe, de a vevő nem tudja sem felszabadítani, sem kifizetni őket. A szervernek tehát kell egy olvasó végpont, amelyből az oldal újra felépítheti a holdot.

## Döntés

1. **`booking.activeHold({ eventId })`**: új query, a `BookingService.activeHold` (`packages/booking/src/booking-service.ts`) egyetlen `findFirst`-tel adja vissza a hold-ot és a székeit árral, vagy `null`-t. A szűrő: `eventId`, `sessionId` **és** `buyerKey`, `status = HELD`, `holdExpiresAt > clock.now()`, rendezés `holdExpiresAt desc`. A szerver dönti el, él-e még a hold; a kliens nem találgat.
2. **Nincs admission kapu** (`publicProcedure`): a hold túlél az admissionön (30 perc), ezért az újratöltésnek akkor is meg kell találnia. Nem szivárogtat: más session `null`-t kap.
3. **A UI egyszer olvas** (`components/hold/hold-controls.tsx`): `useQuery` mount-kor, `staleTime: Infinity`, `refetchOnWindowFocus: false`. A megjelenített hold: `hold.data ?? restored.data`. Ha az oldal maga zárja le a holdot (release, lejárat, order), `forgetHold` a cache-t `null`-ra állítja, így nem "támad fel".

A kulcsötlet: a lejárat ugyanaz a `T < holdExpiresAt` szabály, mint máshol, így egy még nem sweepelt, de lejárt hold is `null`.

## Alternatívák

| Alternatíva                                           | Előny                                                  | Hátrány                                                          | Miért nem itt                                         |
| ----------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `holdId` a `localStorage`-ban/URL-ben, majd `getHold` | nincs új végpont                                       | kliens-állapot elavulhat, más tabon nem működik, árak nélkül     | a szerver az igazság forrása; a `getHold` nem ad árat |
| Csak `buyerKey` szerinti egyezés (mint `getHold`)     | egyszerűbb, bejelentkezett user több eszközön is látja | más session holdját is megmutatná                                | a jegy "aktuális sessiont" kér; szigorúbb választás   |
| Polling / refetch fókuszra                            | mindig friss                                           | verseng az oldal saját lezárásával (release után visszahozhatná) | az oldal tudja, hogyan ér véget a hold                |
| `admittedProcedure` mögé zárni                        | egységes kapuzás                                       | admission lejárta után a hold láthatatlan maradna                | a hold túléli az admissiont                           |

(A trade-offok általános megfontolások, nem mértek.)

## Fogalmak

- **Server state**: a hold igazsága az adatbázisban van, a kliens csak megjeleníti.
- **Lazy expiry**: a lejáratot olvasáskor is ellenőrizzük (`holdExpiresAt > now`), nem várunk a sweeperre.
- **Session vs buyerKey**: a `buyerKey` a vevő (user vagy guest) azonosítója, a `sessionId` egy böngésző-session; itt mindkettőnek egyeznie kell.
- **Cache invalidation (setQueryData)**: a TanStack Query cache-t kézzel állítjuk `null`-ra, hogy a lezárt hold ne térjen vissza.
- **Defence in depth**: a végpont `output` sémája (`activeHoldOutput`) a kimenetet is validálja.

## Mi mehet félre

| Hibamód                                                     | Teszt                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Más session holdja kiszivárog                               | `active-hold.test.ts`: "never returns another session's hold"                                                                                       |
| Ugyanazon user másik sessionje látja                        | "...another session of the same signed-in user"                                                                                                     |
| Lejárt, de nem sweepelt hold megjelenik                     | "is null once the hold is expired, even before the sweeper runs" (határ: `holdExpiresAt - 1 ms` él, `holdExpiresAt` már nem; a sor `HELD` marad)    |
| Felszabadított, sweepelt vagy order-ré vált hold megjelenik | "released", "swept", "became an order"                                                                                                              |
| Több élő hold: nem determinisztikus válasz                  | "returns the latest of several live holds"                                                                                                          |
| Admission nélküli session hibát kap                         | `booking.test.ts`: "needs no admission..."                                                                                                          |
| Reload után nincs countdown/release/checkout                | `queue-and-hold.test.tsx`: "A reload restores the active hold"; `checkout-and-order.test.tsx`: "a hold restored by activeHold checks out as before" |
| Felszabadított hold visszatér                               | "a restored hold can be released, and it stays gone"                                                                                                |

## Interjúkérdések

1. **Miért ellenőrzi a szerver a lejáratot olvasáskor is?** A sweeper 15 másodpercenként fut, így létezik ablak, amikor a sor még `HELD`, de már lejárt. A `holdExpiresAt > now` feltétel ezt kizárja; a teszt bizonyítja, hogy a sor közben `HELD` marad.
2. **Miért `sessionId` és `buyerKey` is?** A `buyerKey` bejelentkezett usernél több eszközön azonos. Csak azt nézve a telefon a laptop holdját mutatná; a `sessionId` ezt szűri.
3. **Miért nem refetch-el a UI?** Az oldal tudja, mikor ér véget a hold; egy refetch versenyezhetne ezzel, és lezárt holdot hozhatna vissza. Ezért egyszeri olvasás plusz `setQueryData(null)`.
4. **Miért nincs admission kapu?** A hold az admissionnél tovább él; kapuval a vevő hold nélkül, de foglalt székekkel maradna.
5. **Mi van, ha egy vevőnek több élő holdja van?** A legkésőbb lejáró jön vissza (`orderBy holdExpiresAt desc`). Ez egy feltételezés, a `.devflow/questions.md` szerint még nyitott megerősítésre.
