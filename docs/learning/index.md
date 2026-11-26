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
- [63: Redis kiesése](63-redis-outages-do-not-hang-booking-or-the-worker.md): lusta, korlátos Redis kapcsolat, worker Redis nélkül is indul, fail open csak a revocationre, TCP stand-in tesztek
- [64: Konzervatív demo reset](64-conservative-demo-reset.md): székek felszabadítása, order/line/ledger megtartása, `ordersKept`, `RESET_BLOCKED` fail closed, késői capture a normál saga szabállyal
- [65: Admin login rate limit és logout](65-admin-login-rate-limit-and-logout.md): limiter a jelszó-összehasonlítás előtt, fail closed, globális limit kompromisszuma, logout cookie törléssel (másolt cookie nem vonható vissza)
- [66: Notification send a tranzakción kívül](66-notification-send-outside-the-transaction.md): pending, send, record három lépés, `beforeTransaction` hook, idempotency key a notification id, crash utáni redelivery
- [38: Deployment](38-deployment.md): pooled Neon URL a webnek, direct a migrációnak, `workflow_run` deploy a CI után, Vercel git deploy kikapcsolva, Fly privát hálózat, JetStream volume-on
- [67: Típusos domain hibakódok](67-typed-domain-error-codes.md): `cause`-ból `data.domainCode` és `seatIds` az error formatterben, explicit lista, stack soha a `data`-ban, a UI nem parsol üzenetet
- [68: Az oldalújratöltés visszaállítja az aktív holdot](68-reload-restores-the-active-hold.md): `activeHold` query, szerver dönti el a lejáratot, `sessionId` + `buyerKey`, egyszeri olvasás és cache törlés
- [69: Korlátos reaping az aktív slotokon](69-bounded-reaping.md): kötegelt atomic Lua `reap` indexekből `LIMIT`-tel, `holders` hash, pass budget, AT-39 egy lépésben
- [26: Stream backpressure és topology hardening](26-stream-backpressure-and-topology.md): `discard: new` backpressure, outbox `PENDING` marad, szűk catch az `ensureTopology()`-ban, outbox lag
- [43: Konfiguráció injektálása és venue migráció](43-config-injection-and-venue-migration-hardening.md): seed parancs a worker appban `parseSeedEnv`-vel, `@ticketarena/db/seed` entry point, lusta `ctx.db()`, duplikált venue-k összevonása a unique index előtt
- [45: Worker loop hibák naplózása](45-worker-loop-error-reporting.md): `FailureReporter`, ok szerinti rate limit (60 s), recovery sor, handler hiba `deliveryCount`-tal a `nak` előtt
