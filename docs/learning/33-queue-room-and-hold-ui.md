# 33: Queue room és hold UI

Ticket: `issues/33-queue-room-and-hold-ui.md`. ADR: [0008](../adr/0008-waiting-room-admission.md) (kliens oldali polling).

## Probléma

A vevő az `/events/[eventId]` oldalon sorba áll, látja a helyét, majd beengedés után seat-eket foglal, és visszaszámlálót lát. A rendszer oldaláról a böngészőnek kell életben tartania az admissiont: a slotot 90 mp tétlenség után reapeli a szerver, és a `queue.status` poll az, ami a cookie-t is kiadja. A UI-nak közben a szerver négy különböző elutasítását külön érthetően kell mutatnia.

## Döntés

1. **A poll egyben heartbeat.** A `useQueueStatus` (`components/queue/queue-room.tsx`) 3 mp-enként kérdezi a `queue.status`-t, de csak `QUEUED` vagy `ADMITTED` állapotban, háttér tabban is. Beengedés után a seat map (`seats.map`) is 3 mp-enként frissül, a hold alatt is, így a slot nem válik tétlenné. A `queue.join` után azonnal újra olvassuk a státuszt, még `ADMISSIBLE`/`ADMITTED` eredménynél is: a cookie-t a status poll adja ki, és a `holdSeats` ezt várja (ADR 0008 szerint nincs push).
2. **Hibakódok szétválasztása.** A `SEAT_UNAVAILABLE` és a `LIMIT_EXCEEDED` is tRPC `CONFLICT`, ezért a `hold-failure.ts` az üzenet elején álló domain kódot parsolja (és innen veszi a foglalt seat id-ket). Ez ismert gyengeség: egy típusos error formatter sokkal stabilabb lenne (follow-up a `.devflow/questions.md`-ben).
3. **Visszaszámláló a szerver határidejére.** A `hold-controls.tsx` a szerver `holdExpiresAt` értékéig számol a kliens órájával. Az eltérő kliensóra csak a kijelzést tolja el; a lejáratról a szerver dönt. 0:00-nál az oldal eldobja a holdot, és alertet mutat; a hold csak a mutation eredményében él, ezért reload elveszti.

A `HoldControls` admitted állapottól függetlenül be van kötve: ha az admission (30 perc) lejár, miközben él a hold, a hold és a `FORBIDDEN` üzenet nem tűnhet el.

## Alternatívák

| Alternatíva                    | Előny                              | Hátrány                                                | Miért nem itt                                                          |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| SSE / WebSocket push           | Azonnali értesítés, kevesebb kérés | Tartós kapcsolat, skálázás, reconnect kezelés          | ADR 0008: kliens polling; a poll amúgy is kell heartbeatnek            |
| Szerver ad hátralévő időt (mp) | Nincs clock skew                   | Hálózati késés pontatlanná teszi, így is számolni kell | A szerver amúgy is dönt a lejáratról; a skew csak kozmetikai           |
| Típusos hibakód a szerverről   | Nincs üzenet-parsolás              | Szerver oldali változtatás (error formatter)           | A ticket UI-ra szól; follow-up                                         |
| Hold tárolása localStorage-ban | Reload után is látszik             | Második igazságforrás a szerver mellett                | Nincs checkout oldal; szerver állapotot nem másolunk kliens storage-ba |

## Fogalmak

- **Polling:** a kliens fix időközönként lekérdezi az állapotot. Egyszerű és tűzfalbarát, de késleltet és forgalmat termel.
- **Heartbeat:** rendszeres jel, hogy a kliens él; ha elmarad, a szerver felszabadítja a slotot (reap).
- **Clock skew:** a kliens és a szerver órája eltér. Itt csak a kijelzést érinti.
- **Live region:** `role="status"` (udvarias) és `role="alert"` (azonnali) elem, amit a screen reader automatikusan felolvas. A `role="timer"` a visszaszámlálón van.
- **Fake timers:** a teszt vezérli az időt (`vi.useFakeTimers`), így 3 mp-es pollt várakozás nélkül lehet vizsgálni.

## Mi mehet félre

- Az idő nem telik el a pollok között, vagy az admitted állapot nem pollol: `queue-and-hold.test.tsx` "polls queue.status every 3 s", "keeps polling ... once admitted", "polling continues while seats are held".
- Azonnali admission cookie nélkül: "an immediate admission polls queue.status before offering to hold".
- A négy elutasítás összemosódik: `test.each` az üzenetekre és "the four refusals are four different messages".
- `FORBIDDEN` után nincs visszaút: "FORBIDDEN stays on screen and the join button returns".
- Lejáró admission eltünteti a holdot: "a live hold stays on screen when the admission lapses".
- Lejárt hold ott marad: "when the countdown ends the hold is gone and the buyer is told".
- Nem csatlakozott látogatót nem pollolunk: "a visitor who has not joined is not polled".

A tesztek valódi tRPC klienssel, csak a `fetch` és az idő mockolásával futnak.

## Interjúkérdések

1. **Miért polling és nem WebSocket?** Az ADR 0008 klienspollingot ír elő, és a poll amúgy is heartbeat, ami életben tartja a slotot és kiadja a cookie-t. Push mellett is kellene heartbeat, így nem spórolnánk meg a pollt (az általános push-trade-off nem mért).
2. **Mi a baj a kliens órájával számolt visszaszámlálóval?** Skew esetén a vevő rossz időt lát, de a szerver dönt a lejáratról, így nincs hibás foglalás. A határidő a szerver `holdExpiresAt` értéke, csak a "most" jön a kliensről.
3. **Hogyan különíted el a `SEAT_UNAVAILABLE`-t a `LIMIT_EXCEEDED`-től?** Mindkettő `CONFLICT`, ezért az üzenet prefixét olvassuk. Törékeny, mert az üzenet szövege szerződés lett; sturdier egy error formatterrel küldött típusos kód.
4. **Miért kell a join után azonnal status?** A cookie-t a `queue.status` adja ki; enélkül a `holdSeats` `FORBIDDEN`-t adna egy már beengedett vevőnek.
5. **Hogyan tesztelsz időzítőket?** Fake timers (`shouldAdvanceTime`), `advanceTimersByTimeAsync` `act`-ben, és csak a hálózat/idő a mock. Így a 3 mp-es poll és a 10 perces számláló gyors és determinisztikus.
