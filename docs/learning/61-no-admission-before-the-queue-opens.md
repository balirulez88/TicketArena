# 61: Nincs admission a queue megnyílása előtt

Ticket: `issues/61-no-admission-before-the-queue-opens.md`. ADR: [0008](../adr/0008-waiting-room-admission.md) (érintetlen, lásd lent). Commit: még nincs (a run ágán, nem commitolt).

## Probléma

A `join` korábban a "queueOpensAt előtt" és a "queueClosesAt után" esetet ugyanúgy kezelte: azonnal admission-t adott. Aki közvetlenül a queue megnyitása előtt érkezett, kapott egy 30 perces admission-t, ami még érvényes volt `onSaleAt`-kor, így kikerülte a randomizált pre-queue-t (ADR 0008). A rendszer oldaláról a tisztesség garanciája sérült: az érkezési idő számított a véletlen sorrend helyett.

## Döntés

1. **Háromfázisú policy.** Az `AdmissionPolicy` egy boolean (`isQueueActive`) helyett `phase(event, now)`-t ad: `NOT_OPEN`, `ACTIVE`, `CLOSED` (`packages/waiting-room/src/admission-policy.ts`). A határok: `queueOpensAt` inclusive, `queueClosesAt` exclusive. A boolean két külön jelentést olvasztott egybe, a három érték ezt szétválasztja.
2. **`NOT_OPEN` eredmény, nem hiba.** A `join` ilyenkor `{ status: "NOT_OPEN", queueOpensAt }`-ot ad, nem tesz be senkit a queue-ba, nem ad admission-t (`queue-service.ts`). Csak a `CLOSED` fázisban ad azonnali `ADMISSIBLE`-t. A tRPC `joinOutput` discriminated union-ja is tartalmazza, így az oldal ki tudja írni, mikor nyit a queue.
3. **Defence in depth a `holdSeats`-ben.** Ha `now < onSaleAt`, `NotOnSaleError` (`NOT_ON_SALE`) dobódik, tRPC-ben `PRECONDITION_FAILED`, és semmi nem íródik (`booking-service.ts`). A határ szigorú: pontosan `onSaleAt`-kor már sikerül. Így akkor sem lehet korán foglalni, ha a queue-oldali szabály hibás vagy később kikerülik.
4. **Seed következmény.** A demo esemény `onSaleInDays: -1`, vagyis a seedelés előtt egy nappal már eladásban van, különben a demo és az `admin.runRace` nem működne.

## Alternatívák

| Alternatíva                                             | Előny                       | Hátrány                                                                                                           | Miért nem itt                                         |
| ------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Marad az azonnali admission korán érkezőnek             | Egyszerű                    | Kikerüli a pre-queue-t                                                                                            | Pont ez a hiba                                        |
| Korai joint is a pre-queue-ba tenni                     | A buyer "foglalja a helyét" | Az ADR 0008 szerint a pre-queue a megnyitás utáni join-okat keveri; korai join-nal újra az érkezési idő számítana | A ticket 28 válasza a `NOT_OPEN`-t írja elő           |
| `NOT_OPEN` hibaként (tRPC error)                        | Kevesebb típus              | A kliens nem kap strukturált időpontot, a normális helyzet kivételként jelenik meg                                | Az oldalnak meg kell mutatnia a nyitási időt          |
| Csak a queue-oldali szabály, `holdSeats`-védelem nélkül | Kevesebb kód                | Egyetlen réteg hibája átengedi a korai foglalást                                                                  | A defence in depth olcsó: egy időpont-összehasonlítás |

(Az alternatívák általános mérlegelések, nem mért adatok.)

## Fogalmak

- **Pre-queue**: az `onSaleAt` előtt csatlakozók sora, véletlen score-ral (`[0,1)`), így az érkezési sorrend nem számít.
- **Admission**: a queue-ból kapott jogosultság (30 perces JWT), amely nélkül nem szabadna foglalni.
- **Defence in depth**: több, egymástól független védelmi réteg ugyanarra a szabályra.
- **Precondition**: olyan feltétel, amit a kérés előtt a külvilág állapota (itt az idő) dönt el, ezért `PRECONDITION_FAILED`, mint a `HOLD_EXPIRED`.
- **Szigorú határ**: `now < onSaleAt` a tiltás, tehát `onSaleAt`-kor engedett; ugyanez a szabály az admission ticker-é.

## Mi mehet rosszul

- Korán érkező admission-t kap: `queue-service.test.ts` (NOT_OPEN, `counts` = 0 queued/0 active, `queueOpensAt - 1 ms`-nál) és `queue.test.ts` (a `status` utána `NOT_QUEUED`).
- Off-by-one a határokon: a policy teszt a `queueOpensAt` (ACTIVE), `queueClosesAt - 1 ms` (ACTIVE) és `queueClosesAt` (CLOSED) értékeket is ellenőrzi; külön teszt a pontosan `queueOpensAt`-kori join-ra.
- Korai foglalás: `booking-service.test.ts` ellenőrzi, hogy `onSaleAt - 1 ms`-nál `NOT_ON_SALE`, a hold/outbox darabszám és a seat státusz változatlan, `+1 ms`-nál sikerül; `booking.test.ts` a `PRECONDITION_FAILED` leképezést.
- A demo elromlik a szabálytól: `seed.test.ts` (a demo `onSaleAt` a seedelés előtt van, a queue zárt, a többi esemény jövőbeli).
- Ismert korlát: a már seedelt adatbázis megtartja a régi `onSaleAt`-ot, resetelni kell (`docs/database/index.md`).

## Interjúkérdések

1. **Miért nem hiba a `NOT_OPEN`?** A korai érkezés elvárható, normális állapot, és a kliensnek adat kell hozzá (`queueOpensAt`). Discriminated union-nal típusbiztosan kezelhető, nem kell hibakódokat parse-olni.
2. **Miért kell a `holdSeats`-ben is ellenőrizni, ha a join már kizárja?** A queue Redis-állapot és policy-logika, a foglalás a Postgres-oldali igazság. Egy független idő-ellenőrzés akkor is véd, ha az admission kiadása vagy érvényessége hibás. Az ADR szabálya szerint a seat állapotát nem a Redis dönti el.
3. **Miért háromfázisú enum a boolean helyett?** A boolean elveszti, hogy a "nem aktív" korábbi vagy későbbi időt jelent, pedig a két esetre ellentétes a helyes válasz (várni vs. azonnal belépni). Az enum a döntést kikényszeríti a hívónál.
4. **Mi a határ, és miért?** `now < onSaleAt` tiltott, tehát pontosan `onSaleAt`-kor már lehet foglalni; ez egyezik a ticker szabályával, és tesztelt `-1 ms`/`+1 ms`-mal.
5. **Mi maradt nyitva?** Az ADR 0008 szövege ("a queue ablakon kívül azonnal admit") változatlan, a `.devflow/questions.md` szerint ember dönt a pontosításról vagy felváltó ADR-ről.
