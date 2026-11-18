# 14: Hold expiry (lazy és sweeper)

Ticket: `issues/done/14-hold-expiry.md` · commit `d21ab7a` · ADR: [0005](../adr/0005-postgres-seat-state-row-locks.md)

## Probléma

Aki felad egy hold-ot (10 perces foglalás) és elmegy, annak a székei nem blokkolhatnak másokat 10 percnél tovább. A rendszer oldaláról nézve a lejárat időponttól függ, és az idő olvasása, a zárak és a `placeOrder` (fizetésre váltás) versenyezhetnek: ha a checkout és a lejárat is "nyer", egy szék kétszer lenne eladva vagy egy fizető vevő üres kézzel maradna.

## Döntés

Két egymást kiegészítő mechanizmus, egy közös szabállyal.

1. **Lazy expiry** (`holdSeats`, `packages/booking/src/booking-service.ts`, `freeSeats`): egy `HELD` szék szabadnak számít, ha a hold-ja lejárt. Nem kell megvárni a sweepert, így a lejárat azonnal "hat".
2. **Sweeper** (`sweepBatch` + `apps/worker/src/sweeper.ts`): a worker 15 másodpercenként lefuttatja. `FOR UPDATE SKIP LOCKED`-kal kiválasztja a lejárt `HELD` hold-okat, `EXPIRED`-re állítja őket, a székeket `AVAILABLE`-re, és ugyanabban a tranzakcióban `hold.expired` outbox eseményt ír.
3. **Egyetlen szabály, egyetlen `T`**: a hold érvényes, ha `T < holdExpiresAt` (`isExpiredAt`). A `T`-t (`clock.now()`) a zárak megszerzése *után* olvassuk, mert addigra senki más nem módosíthatja a sorokat: ez a linearizációs pont (ADR 0005).

A kulcs a zár-sorrend: buyer advisory lock, hold sor, majd székek `id` szerint. `placeOrder` és a sweeper ugyanazt a hold-sort zárolja, ezért sorba állnak. Ha a `placeOrder` nyert, a sweeper vagy kihagyja a sort (`SKIP LOCKED`), vagy már `ORDERED`-et lát. Ha a sweeper nyert, a `placeOrder` `EXPIRED` státuszt lát, és `HOLD_EXPIRED`-et dob. Soha nem lesz mindkettő.

Plusz védőháló: `placeOrder` ellenőrzi, hogy minden szék `holdId`-ja még egyezik a hold-dal (AT-11), mert a lazy átvétel miatt egy szék már másé lehet.

## Alternatívák

| Alternatíva | Előny | Hátrány | Miért nem itt |
|---|---|---|---|
| Csak sweeper, lazy nélkül | Egyszerű, egy hely ír | Akár 15 mp-ig blokkolt szék lejárat után; sweeper-kiesés esetén tovább | A spec szerint lejárat után azonnal foglalható kell legyen (AT-07) |
| Redis TTL kulcs a lejárathoz | Gyors, magától lejár | Második igazságforrás; kulcsvesztés = inkonzisztens szék | A szék állapotát soha nem Redis dönti el (ADR 0005, CLAUDE.md) |
| SQL `now()` / `clock_timestamp()` | Nem kell injektált óra | `now()` a tranzakció elejére van rögzítve; tesztből nem vezérelhető | A versenyeket determinisztikusan kell tesztelni (AT-08) |
| Sweeper `NOWAIT`/várakozó zárral | Nem hagy ki sort | A sweeper blokkolná a checkoutot, vagy hibával állna le | `SKIP LOCKED`: a kihagyott sort a következő kör úgyis megtalálja |

## Fogalmak

- **Lazy expiry**: a lejáratot olvasáskor értelmezzük, nem írjuk be előre; az adat "késve" frissül, de a döntés helyes.
- **Row lock / `FOR UPDATE`**: a sor zárolása a tranzakció végéig; más tranzakció várakozik.
- **`SKIP LOCKED`**: a zárolt sorokat átugorja ahelyett, hogy várna; háttérmunkához való, ahol a kihagyás belefér.
- **Linearization point**: az az egyetlen pillanat, ahol a döntés "megtörténik"; itt a zárak utáni `clock.now()`.
- **Outbox**: az állapotváltozással azonos tranzakcióban írt esemény, így `hold.expired` akkor és csak akkor létezik, ha a lejárat commitolt.
- **Idempotens sweep**: egy újrafutás ugyanazt az állapotot adja; a kihagyott hold a következő körben lejár.

## Mi romolhat el

| Hiba | Teszt |
|---|---|
| Lejárt hold széke blokkolja a másik vevőt | `hold-expiry.test.ts`: AT-07 |
| `T` a zárra várás előtt olvasva, elavult döntés | `decides expiry with T read after the seat locks` |
| Fizetés közben lejár a hold | AT-08 (fake clock a lock-várakozás alatt) |
| Checkout és sweeper is nyer | AT-09, mindkét érkezési sorrendben |
| A hold-ról lecsúszott szék kerül eladásra | AT-11 |
| A sweeper nem engedi el a másik hold által átvett széket | `does not free a seat another hold took over lazily` |
| A sweeper vár egy zárolt hold-ra | `skips a hold locked by another transaction without waiting` |
| Határeset: `T = holdExpiresAt` vs. 1 ms előtte | `at T = holdExpiresAt ...`, `one millisecond before` |

Ismert nyitott pont (a commit follow-upjai közül): a `sweepBatch` a `T`-t a hold-zár *előtt* olvassa. Ez a kódkomment szerint belefér, mert a lejárat nem mozdul és `SKIP LOCKED` nem vár, de az ADR szigorú olvasatától eltér, és külön indoklást kér.

## Interjúkérdések

1. **Miért kell lazy expiry, ha van sweeper?** A sweeper 15 mp-enként fut és ki is eshet; a lazy szabály miatt a lejárt hold széke azonnal foglalható (AT-07). A sweeper csak takarít és eseményt küld.
2. **Hogyan zárja ki a rendszer, hogy a checkout és a sweeper is nyerjen?** Mindkettő ugyanazt a hold-sort zárolja `FOR UPDATE`-tel, ezért sorba állnak. A vesztes a nyertes commitolt állapotát látja (`ORDERED` vagy `EXPIRED`), ezt az AT-09 mindkét sorrendben bizonyítja.
3. **Miért `SKIP LOCKED` a sweepernél, de várakozó zár a székeknél?** A felhasználói kérés nem kaphat téves "foglalt" választ, ezért vár (ADR 0005). A háttérsweeper kihagyhat, mert a következő kör pótolja.
4. **Miért injektált óra, miért nem SQL `now()`?** A `now()` a tranzakció elejére rögzített, így zárra várás után elavult lenne. Az injektált órát a teszt a lock-várakozás közben el tudja tolni (AT-08).
5. **Mit jelent, hogy a `T` a zárak után olvasandó?** Addig más módosíthatja a sorokat; utána a döntés és az állapot konzisztens. Ezért a `holdSeats` és a `placeOrder` is a zárolás után hívja a `clock.now()`-t.
