# 51: Log redaction policy

**What to build:** buyer contact details never reach the logs, even when an error that carries them is logged whole, and the policy is written down. Resolves TD-048 in `docs/technical-debt.md` (LOW, SECURITY). Must merge before deployment (ticket 38).

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [x] The web and worker loggers redact buyer contact fields (email and phone, wherever they appear in a logged object, including inside a serialized error) before anything is written.
- [x] TD-048: a test makes a consumer handler fail with an error that carries a buyer's email and phone, and asserts that the logged line keeps the error's name and the correlation ids but contains neither contact detail.
- [x] A test of the web logger shows the same for a tRPC procedure error.
- [x] The redaction policy (what is redacted, where, and why) is documented under Logging and ids in `docs`, and verified by the docs test.
- [x] ~~Every entry in `docs/technical-debt.md` whose Target is ticket 51 (TD-048) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).~~ Superseded by [ADR 0024](../../docs/adr/0024-frozen-debt-register-check.md) (Q11): the register is frozen and never edited; the evidence is recorded below instead.
- [x] Free-text redaction covers every phone and email format the checkout accepts (review of PR #19: a dot-separated phone passed `placeOrder` and escaped the redactor). `booking.placeOrder` validates its contact with the shared `buyerContactSchema`, and a phone shaped like an IPv4 address is refused because the redactor keeps addresses.

## TD-048 resolution evidence

TD-048 (handler errors logged whole with no redaction policy) is resolved by this ticket. The frozen register keeps its `PLANNED` status (ADR 0024); these tests prove the fix:

- Worker: `apps/worker/src/log-redaction.test.ts` :: "TD-048: a handler error carrying a buyer's email and phone is logged with its name and the correlation ids but neither contact detail" and "redacts contact fields in bindings and fields before the line is written".
- Web logger: `apps/web/src/server/logger.test.ts` :: "a tRPC procedure error carrying a buyer's email and phone is logged with its name, path and correlation ids but neither contact detail".
- Actual tRPC route error hook: `apps/web/src/app/api/trpc/[trpc]/route.test.ts` :: "an error whose message and stack carry a dot-separated phone and an email is logged by the route's onError with both masked" (the route's own `POST` and `onProcedureError`, output captured at stdout).
- Accepted formats: `packages/contracts/src/log-redaction.test.ts` :: "masks the accepted checkout phone %j in free text" and "masks the accepted checkout email %j in free text" (each case is first accepted by `buyerContactSchema`), and "refuses a phone shaped like an IPv4 address, which the redactor keeps".
- Policy docs: `packages/messaging/src/docs.test.ts` :: "docs/architecture states the log redaction policy: what is redacted, where and why (TD-048)".
