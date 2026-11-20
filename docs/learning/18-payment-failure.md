# 18: Fizetési hiba és lemondás

Ticket: `issues/18-payment-failure.md` · ADR: [0006](../adr/0006-booking-saga-payment-ledger.md), [0003](../adr/0003-transactional-outbox.md), [0007](../adr/0007-three-layer-idempotency.md)

## Probléma

Egy fizetési kísérlet elbukhat, de ez még nem jelenti, hogy a vevő nem fog fizetni: egy átmeneti hiba után a következő kísérlet még sikerülhet a határidőig. Ha a rendszer minden hibára lemondaná a rendelést és elengedné a székeket, egy később mégis befutó capture-höz már nem lenne szék (és vissza kellene téríteni). Ha viszont soha nem mondaná le, a véglegesen elutasított vevő székei 6 percig (határidő + grace) feleslegesen blokkolva maradnának.

## Döntés

1. **`final` flag a `payment.failed` eseményen** (`packages/contracts/src/payment-failed.ts`). A Payment szolgáltatás dönti el, hogy a hiba végleges-e, mert csak ő látja a saját kísérleteit (ADR 0009). A mock: `+fail@` email → `card_declined`, `final: true`; egy véletlen hiba (`successRate` alatti húzás az injektált `Random`-ból) → `provider_declined`, `final: false`.
2. **Invariáns a Payment modulban** (`apps/worker/src/payment/payment-handler.ts`): `final: true` soha nem megy ki, ha a rendelésnek van másik `ATTEMPTING` vagy `CAPTURED` kísérlete. Az ellenőrzés zár nélküli, és csak a commitolt kísérleteket látja; ez elég, amíg az MVP rendelésenként csak az 1. kísérletet rögzíti (az `(orderId, attemptNo)` unique index ezt az adatbázisban is kikényszeríti). Párhuzamos kísérletekre nem biztonságos: az újrapróbálások előtt a kísérleteket rendelésenként sorba kell állítani minden ágban.
3. **A booking saga a tiszta `decide`-ra bízza** (`saga-decision.ts`): `failed` + `final` + `PENDING_PAYMENT` + nincs `APPLIED` → `transition final_failure`. A `cancel` (`payment-saga.ts`) egy tranzakcióban: rendelés `CANCELLED` feltételes update-tel, a `IN_CHECKOUT` székek `AVAILABLE`-re (`holdId`, `claimBuyerKey` törölve), `order.cancelled` az outboxba. Nincs ledger sor, mert pénz nem mozdult. Nulla érintett sor kivételt dob, sosem "siker".
4. **Nem végleges hiba = `noop` (`attempt_failed`)**: log és `payment_attempt_failed` számláló (Redis, best-effort, fire-and-forget), a rendelés nyitva marad a határidőig; utána a sweeper `EXPIRED`-re állítja.
5. **Notification**: új durable consumer `notification-cancelled` (`ta.order.cancelled`), ugyanaz a handler, `order-cancellation` sablon. A booking oldalon `booking-saga-failed` consumer kapja a `ta.payment.failed`-et, mert egy durable consumernek egy filter subjectje van.

## Alternatívák

| Alternatíva                                         | Előny                             | Hátrány                                                                 | Miért nem itt                                                                                                  |
| --------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Minden hiba lemondja a rendelést                    | Egyszerű, gyorsan szabadul a szék | Egy későbbi sikeres kísérlet pénze lemondott rendelésre érkezik: refund | ADR 0006: "a failed attempt is not a failed checkout"                                                          |
| A booking dönti el a véglegességet (pl. hibaszám)   | Nem kell flag                     | A booking nem látja a Payment kísérleteit; cross-schema olvasás kellene | Szolgáltatásonkénti séma, csak eseményekből tanulnak (ADR 0009)                                                |
| Rendelésenkénti zár / sorba állítás a kísérletekre  | Párhuzamos kísérletekre is helyes | Több kód és zártartás a Payment úton, ma nincs mit védenie              | Az MVP csak az 1. kísérletet írja (`@@unique([orderId, attemptNo])`); a zár az újrapróbálások ticketjére marad |
| Metrika a `BookingMetric` típusban (dashboardon is) | Egy port                          | Admin router, reader, UI és tesztek is változnának                      | Ticketen kívüli; külön `SagaMetrics` port, ugyanabba a hash-be ír                                              |

## Fogalmak

- **Payment attempt**: egy terhelési próbálkozás a Payment szolgáltatásban; elbukhat nem véglegesen.
- **Final failure**: a Payment kijelenti, hogy erre a rendelésre több kísérlet nem lesz sikeres.
- **Feltételes update**: `updateMany ... where status = PENDING_PAYMENT`; a `count` mutatja, hogy a döntés még érvényes-e.
- **Best-effort metrika**: a számláló hibája logolódik, de soha nem buktatja el az üzleti tranzakciót.

## Mi romolhat el

| Hiba                                                         | Teszt                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `FAILED` kísérlet ok nélkül, vagy ok nem `FAILED` kísérleten | `payment-schema.test.ts`: `records a FAILED attempt only with a failureReason...`              |
| `final: true` másik élő vagy capture-ölt kísérlet mellett    | `payment-handler.test.ts`: `never emits final: true while another attempt for the order is %s` |
| Lemondás, de a székek `IN_CHECKOUT`-ban ragadnak             | `payment-saga.test.ts`: `cancels a PENDING_PAYMENT order on a final failure...`                |
| Outbox hiba után félig lemondott rendelés                    | `rolls the cancellation back when the outbox write fails...`                                   |
| Nem végleges hiba lemondja a rendelést                       | `leaves the order and seats alone on a non-final failure...`, AT-17                            |
| Megerősített rendelés lemondása késői hibára                 | `does not cancel a confirmed order on a final failure`                                         |
| Redis kiesés elbuktatja a sagát                              | `still settles a non-final failure when the metric cannot be recorded`                         |
| Végpontok közt: lemondás, szék szabad, egy email             | `payment-failure-flow.test.ts`: AT-16                                                          |

## Interjúkérdések

1. **Miért nem mondja le a rendszer a rendelést minden fizetési hibára?** Mert egy kísérlet hibája átmeneti lehet; ha a következő sikerül, a pénznek legyen hová érkeznie. Csak a Payment által véglegesnek jelölt hiba zárja le a checkoutot.
2. **Ki dönti el, hogy egy hiba végleges, és miért ő?** A Payment, mert csak ő látja az összes kísérletet; a booking nem olvashatja a `payment` sémát (ADR 0009).
3. **Hogyan garantálod, hogy `final: true` ne menjen ki egy folyamatban lévő kísérlet mellett?** Megszámolom a rendelés többi commitolt `ATTEMPTING`/`CAPTURED` kísérletét; ha van ilyen, `final: false`. Ez addig elég, amíg rendelésenként egyetlen kísérlet van; újrapróbálásnál előbb rendelésenként sorba kell állítani a kísérleteket.
4. **Mi történik, ha a lemondás és egy sikeres capture versenyez?** Mindkettő a rendelés sorát zárolja `FOR UPDATE`-tel; a második már a nyertes állapotát látja, és a `decide` mátrix dönt (pl. `CANCELLED` + siker → refund, egy későbbi ticket építi).
5. **Miért van a metrika a tranzakción belül, és mi ennek az ára?** Mert a saga handler a runner tranzakciójában fut; fire-and-forget, így nem lassít és nem buktat, de egy visszagörgetett és újrapróbált üzenet többször is számolódhat.
