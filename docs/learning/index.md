# Tanulási jegyzetek

Ticketenként egy rövid jegyzet, amely az interjún megvédhető tervezési döntéseket foglalja össze.

- [13: Release a hold](13-release-hold.md): lock sorrend, holdId-feltételes seat felszabadítás, outbox egy tranzakcióban
- [14: Hold expiry (lazy és sweeper)](14-hold-expiry.md): lazy expiry, `SKIP LOCKED` sweeper, egy `T` a zárak után
- [60: Lejárt hold felszabadítása](60-release-of-an-expired-hold.md): egy `T < holdExpiresAt` szabály, elutasítás írás előtt, `HOLD_EXPIRED` → `PRECONDITION_FAILED`, határteszt
- [61: Nincs admission a queue megnyílása előtt](61-no-admission-before-the-queue-opens.md): háromfázisú `AdmissionPolicy`, `NOT_OPEN` eredmény, `NOT_ON_SALE` defence in depth
- [62: Re-join megtartja az élő admissiont](62-rejoin-keeps-a-live-admission.md): atomic Lua `join`, `ADMITTED` eredmény, check-then-act race elkerülése
- [31: Admission token enforcement](31-admission-token-enforcement.md): HS256 JWT + Redis `jti` revocation, `admittedProcedure`, fail closed, `placeOrder` nincs kapuzva
- [33: Queue room és hold UI](33-queue-room-and-hold-ui.md): polling mint heartbeat, hibakód-parsolás, clock skew, fake timers
- [34: Checkout és order status UI](34-checkout-and-order-status-ui.md): kliensoldali idempotency key checkout kísérletenként, at-least-once retry, polling végállapotig
- [18: Fizetési hiba és lemondás](18-payment-failure.md): `final` flag, sikertelen kísérlet ≠ sikertelen checkout, `final: true` invariáns, `CANCELLED` + székek felszabadítása egy tranzakcióban
- [19: Refund obligation késői capture esetén](19-refund-obligation-for-late-capture.md): `REFUND_REQUESTED` ledger + outbox egy tranzakcióban, AT-20, ismeretlen order refund advisory lockkal
- [20: Refund execution](20-refund-execution.md): `payment.refunds` PK + `ON CONFLICT DO NOTHING`, emit csak ha írt sort, ledger `REFUNDED` feltételes update-tel, AT-23
- [21: Refund értesítések](21-refund-notifications.md): egy handler öt esemény-típusra, `sourceEventId` dedupe, contact nélküli refund ack, AT-43
- [50: Payment-flow tesztizoláció és redelivery](50-payment-flow-test-isolation-and-redelivery-coverage.md): `createMany skipDuplicates` az `(orderId, attemptNo)` kulcson, race teszt table lockkal és `pg_stat_activity`-vel, stream izoláció, `nak` utáni redelivery
- [54: Tranzakció timeoutok és retry](54-transaction-timeouts-and-retries.md): `SET LOCAL` `lock_timeout`/`statement_timeout`, retry csak `40P01`/`55P03`/`40001`-re jitterrel, `BOOKING_BUSY` vs internal error, 72,6 s legrosszabb eset
- [55: Determinisztikus tranzakciós tesztek](55-deterministic-transaction-tests.md): `waitForPg` + `pg_blocking_pids` időzítés helyett, közös testing helper, tesztenkénti kliens, shuffle, rollback bizonyítása
