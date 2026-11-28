# 22: Késői kézbesítés, dupla fizetés és összeg-eltérés

Ticket: `issues/22-late-delivery-double-payment-mismatch.md`. Commit: még nincs. ADR: 0006 (saga), 0007 (consumer dedupe), 0009 (séma szolgáltatásonként).

## Probléma

A vásárló időben fizet, de a `payment.succeeded` esemény csak később ér a bookinghoz (broker backlog, leállt consumer). Előfordulhat az is, hogy a provider kétszer vonja le a pénzt, vagy rossz összeget/devizát von. A rendszernek ilyenkor soha nem szabad kétszer megerősítenie a rendelést vagy rossz összegért megerősítenie, a levont pénzt pedig vissza kell adni.

## Döntés

1. **"Időben" = `capturedAt <= paymentDeadline`, a kézbesítéstől függetlenül.** A `decideSucceeded` (`packages/booking/src/saga-decision.ts`) a provider időbélyegét nézi. Egy időben levont, de késve kézbesített fizetés megerősít, amíg az order `PENDING_PAYMENT` (AT-19). Ha a sweeper már `EXPIRED`-re tette, az eredmény `late_delivery` refund és `late_delivery_refund` számláló (AT-18).
2. **A grace best-effort.** A sweeper a `paymentDeadline + 60 s` után, 15 másodpercenként fut, és kihagyja a zárolt ordert. Ezért nincs garancia: a túl későn kézbesített, de időben levont fizetés refund lesz. Ezt a spec és a `docs/messaging/index.md` rögzíti, a számláló teszi láthatóvá.
3. **`+double@` két attempt egy tranzakcióban** (`apps/worker/src/payment/payment-handler.ts`, `captureAgain`). Az attempt 1 és 2 külön `paymentId`-t kap. Zár nem kell az orderhez, mert csak az a tranzakció ír attempt 2-t, amelynek az attempt 1 insertje (unique `(orderId, attemptNo)`) nyert. Egy párhuzamos `order.placed` ismétlés az el nem commitolt attempt 1-re vár, majd kihagyja a sorát.
4. **Második fizetés `CONFIRMED` orderre = refund (`order_confirmed`).** A ledgerben egy partial unique index (`WHERE disposition = 'APPLIED'`, migráció `20261103010000`) legfeljebb egy `APPLIED` sort enged orderenként. A döntési logika is refundot ad, az index védőháló.
5. **Összeg vagy deviza eltérés = `amount_mismatch` refund**, az order `PENDING_PAYMENT` marad, a székek `IN_CHECKOUT`.
6. **Broker redelivery**: a `processed_messages` a handler előtt elnyeli, így nincs második refund, számláló vagy outbox esemény.

## Alternatívák

| Alternatíva                                       | Előny                        | Hátrány                                         | Miért nem itt                                                               |
| ------------------------------------------------- | ---------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Időt a kézbesítéskor mérni                        | Egyszerű, nincs provider idő | A vásárló a backlog miatt veszít, hamis refund  | A spec a capture időt kéri                                                  |
| Grace meghosszabbítása a beérkező fizetésig       | Kevesebb késői refund        | Székek tovább foglaltak, a sweeper bonyolultabb | Phase 2: provider státusz-lekérdezés (ADR 0006)                             |
| Per-order advisory lock a `+double@` attemptekhez | Valódi retry-okhoz is jó     | Extra zár, a mock-nak nem kell                  | Az attempt 1 unique insert már sorosít; valódi retry-hoz szerializálni kell |
| Csak a kódra bízni az egyetlen `APPLIED`-et       | Nincs migráció               | Versenyhelyzetnél két megerősítés is lehet      | Az index adatbázis-szinten kényszerít                                       |

## Fogalmak

- **Settlement grace**: a határidő utáni türelmi idő (60 s), mielőtt a sweeper lejáratja az ordert; itt best-effort.
- **Provider time**: a `capturedAt`, a provider órája szerint, szemben a kézbesítés idejével.
- **Partial unique index**: csak a feltételnek megfelelő sorokra érvényes egyediség; itt egy `APPLIED` sor orderenként.
- **Idempotency**: ugyanaz az üzenet újrafeldolgozása nem változtat az eredményen; a `processed_messages` ezt message id alapján adja.
- **Ledger**: `order_payments`, minden fizetés sorsa (`APPLIED`, `REFUND_REQUESTED`, `REFUNDED`).

## Mi romolhat el

- Késve kézbesített, időben levont fizetés tévesen megerősít vagy tévesen refund: `late-delivery-double-payment-flow.test.ts` AT-19 (határon és előtte) és AT-18 (egy refund, egy számláló).
- Két fizetés két megerősítést ad: AT-21 teszt mindkét sorrendben és párhuzamos kézbesítéssel, pontosan egy `APPLIED`, egy refund.
- Rossz összeg vagy deviza megerősít: AT-22 `it.each`.
- Dupla számlálás vagy refund redeliverynél: a teszt eldobja az első ack-ot, a broker újrakézbesít, mégis egy `processed_messages` sor, egy outbox esemény.
- `+double@` harmadik attemptet írna ismételt `order.placed`-nél: `payment-handler.test.ts` ("only twice ... new event id"). Véletlen hibát is felülír (`+double@` mindig capture).
- Teljes út: hold, order, worker, `+double@` végén `APPLIED` és `REFUNDED`.

## Interjúkérdések

1. **Miért a `capturedAt` dönti el az "időben" kérdést?** A kézbesítés ideje a rendszer késése, nem a vásárlóé. Ha azt mérnénk, egy backlog jogos fizetéseket utasítana el.
2. **Miért nem kell zár a `+double@` második attemptjéhez?** Csak az az egy tranzakció ír attempt 2-t, amelyik az `(orderId, 1)` unique insertet megnyerte. A versenytárs ezen vár, majd kihagyja a sort. Valódi retry-oknál ez már nem elég, ott orderenként szerializálni kell.
3. **Hogyan lesz biztosan egy `APPLIED` fizetés?** A `decideSucceeded` `CONFIRMED` orderre refundot ad, és a partial unique index adatbázis-szinten is tiltja a másodikat. Az alkalmazás-logika és az index együtt véd.
4. **Mi a grace best-effort jelentése, és mi az ára?** Nem garantáljuk, hogy minden időben levont fizetés megerősít: a túl késői kézbesítés refund. Ezt a `late_delivery_refund` számláló mutatja (ez maga is best-effort, rollback és retry után túlszámolhat).
5. **Miért nem számol kétszer a redelivery?** A `processed_messages` sor ugyanabban a tranzakcióban jön létre, mint az üzleti írás, és a handler előtt ellenőrződik. A második kézbesítés a handlerig sem jut el.
