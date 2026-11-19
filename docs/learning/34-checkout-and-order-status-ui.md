# 34: Checkout és order status UI

Ticket: `issues/34-checkout-and-order-status-ui.md`, ADR: `docs/adr/0007-three-layer-idempotency.md`.

## Probléma

A vevőnek van egy hold-ja, e-mailt (és opcionálisan telefonszámot) ad meg, majd látni akarja, hogy a rendelése CONFIRMED, CANCELLED vagy EXPIRED lett-e. A hálózat megbízhatatlan: ha a válasz elvész, a böngésző újrapróbálkozik, és a rendszernek nem szabad két rendelést létrehoznia. A rendelés állapota közben a szerveren, aszinkron változik (fizetés, lejárat), ezért az oldalnak magától kell frissülnie.

## Döntés

**1. Az idempotencyKey egy checkout kísérlethez tartozik.** Egy kísérlet = a hold + a beküldött contact. A kulcsot `crypto.randomUUID()` adja, és `useRef`-ben él (`checkout-form.tsx`, `attemptFor`). Ugyanazzal a contacttal újraküldve (pl. hálózati hiba után) ugyanaz a kulcs megy, így a szerver a már létrehozott rendelést adja vissza. Más contact új kulcsot kap, mert ugyanaz a kulcs két különböző kéréssel a szerveren `IDEMPOTENCY_KEY_REUSED` hiba (ADR 0007). Új hold új formot mountol, így nem örökli a régi kulcsot. Ár: ha a válasz elveszett, és a vevő közben szerkeszti a contactot, az új kérés már `HOLD_NOT_ACTIVE`-ot kaphat, mert a hold-ot az első kérés elfogyasztotta.

**2. Polling a végállapotig.** Az `OrderStatus` (`order-status.tsx`) a TanStack Query `refetchInterval` függvényével 2 másodpercenként kérdezi a `getOrder`-t, de csak `PENDING_PAYMENT` alatt. Végállapotban (CONFIRMED/CANCELLED/EXPIRED) vagy `NOT_FOUND`/`BAD_REQUEST` esetén `false`-t ad vissza, tehát leáll. Egy sikertelen poll nem törli a legutóbbi ismert állapotot.

**3. Hibák felismerése.** A `checkout-failure.ts` a tRPC kódból és az üzenet domain-kód prefixéből dönt: `HOLD_EXPIRED` (PRECONDITION_FAILED), `IDEMPOTENCY_KEY_REUSED` (CONFLICT, mert a CONFLICT több hibát is takar). A refund tájékoztatás állapotonként fix szöveg, mert a `getOrder` nem ad refund adatot (követő feladat: a ledger dispositionjeinek kitétele).

## Alternatívák

| Alternatíva                                         | Előny                          | Hátrány                                                           | Miért nem itt                                                      |
| --------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Kulcs minden submitnál új                           | Egyszerű, sosem ütközik        | Elveszett válasz után dupla rendelés                              | Pont az idempotency értelmét veszi el                              |
| Egy kulcs a form teljes életére                     | Egyszerű, mindig retry-barát   | Szerkesztett contact + ugyanaz a kulcs = `IDEMPOTENCY_KEY_REUSED` | A vevő nem tudna javítani                                          |
| Szerver által adott kulcs / előre létrehozott order | Nincs kliensoldali kulcslogika | Extra round trip és új API                                        | Az ADR 0007 kliens kulcsot használ                                 |
| WebSocket/SSE push a státuszra                      | Azonnali, kevesebb kérés       | Infra és kapcsolatkezelés                                         | 2 s polling elég és egyszerű (általános trade-off, itt nem mértük) |
| Fix polling végállapot után is                      | Egyszerűbb kód                 | Felesleges terhelés                                               | A végállapot sosem változik                                        |

## Fogalmak

- **Idempotency key**: a kliens által generált azonosító, amellyel a szerver felismeri az ismételt kérést, és nem hajtja végre újra.
- **At-least-once retry**: a kliens addig próbálkozik, amíg választ nem kap, ezért a szerver többször is megkaphatja ugyanazt a kérést; az idempotency teszi ezt biztonságossá.
- **Polling until terminal state**: periodikus lekérdezés, amely a végállapot elérésekor leáll.
- **Terminal (végső) állapot**: olyan állapot, amelyből a rendelés már nem lép ki.
- **zod validáció**: a form bemenetét a határon ellenőrizzük (`z.email`, opcionális telefon, üres telefon kimarad a contactból).

## Mi mehet rossz

- Elveszett válasz után dupla rendelés: a retry ugyanazt a kulcsot küldi (teszt: "a retry after a network error reuses the idempotency key").
- Kulcs-újrahasználat más kéréssel: contact-változás új kulcsot ad (teszt: "changed contact details are a new checkout attempt with a new key").
- Régi hold kulcsa új holdon: teszt "a new hold is a new checkout attempt with a new key".
- A vevő nem érti a hibát: külön üzenet a lejárt hold-ra és a kulcs-ütközésre (tesztek: "HOLD_EXPIRED says...", "IDEMPOTENCY_KEY_REUSED says...", "...are different messages").
- Végtelen polling: teszt "polls getOrder every 2 s until a final state, then stops"; ismeretlen rendelésre "an unknown order says it was not found".
- Üres telefon miatt API-elutasítás: teszt "an empty phone is left out of the contact".

## Interjúkérdések

1. **Miért nem generálunk minden submitnál új kulcsot?** Mert ha a válasz elvész, a szerver már létrehozhatta a rendelést, és az új kulcs másodikat hozna létre. Az azonos kulcs miatt a szerver a meglévő rendelést adja vissza.
2. **Mikor kell mégis új kulcs?** Ha a kérés tartalma változik (más contact) vagy új hold jön. Ugyanaz a kulcs két különböző kéréssel `IDEMPOTENCY_KEY_REUSED` lenne (ADR 0007).
3. **Mi a hátránya ennek a tervnek?** Ha a válasz elveszett, és a vevő szerkeszti a contactot, az új kulcsú kérés `HOLD_NOT_ACTIVE`-ot kaphat, mert a hold már elfogyott. Ezt tudatosan elfogadtuk.
4. **Hogyan áll le a polling?** A `refetchInterval` függvény a legutóbbi adat alapján `false`-t ad végállapotnál, így nincs külön timer vagy cleanup.
5. **Miért fix szöveg a refund információ?** A `getOrder` nem ad refund adatot; a valós haladás kiteréséhez a ledger dispositionjeit kell kitenni (követő feladat).
