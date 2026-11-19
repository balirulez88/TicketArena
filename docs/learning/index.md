# Tanulási jegyzetek

Ticketenként egy rövid jegyzet, amely az interjún megvédhető tervezési döntéseket foglalja össze.

- [13: Release a hold](13-release-hold.md): lock sorrend, holdId-feltételes seat felszabadítás, outbox egy tranzakcióban
- [14: Hold expiry (lazy és sweeper)](14-hold-expiry.md): lazy expiry, `SKIP LOCKED` sweeper, egy `T` a zárak után
- [61: Nincs admission a queue megnyílása előtt](61-no-admission-before-the-queue-opens.md): háromfázisú `AdmissionPolicy`, `NOT_OPEN` eredmény, `NOT_ON_SALE` defence in depth
- [62: Re-join megtartja az élő admissiont](62-rejoin-keeps-a-live-admission.md): atomic Lua `join`, `ADMITTED` eredmény, check-then-act race elkerülése
- [31: Admission token enforcement](31-admission-token-enforcement.md): HS256 JWT + Redis `jti` revocation, `admittedProcedure`, fail closed, `placeOrder` nincs kapuzva
