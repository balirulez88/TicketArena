# 51: Log redaction policy

**What to build:** buyer contact details never reach the logs, even when an error that carries them is logged whole, and the policy is written down. Resolves TD-048 in `docs/technical-debt.md` (LOW, SECURITY). Must merge before deployment (ticket 38).

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The web and worker loggers redact buyer contact fields (email and phone, wherever they appear in a logged object, including inside a serialized error) before anything is written.
- [ ] TD-048: a test makes a consumer handler fail with an error that carries a buyer's email and phone, and asserts that the logged line keeps the error's name and the correlation ids but contains neither contact detail.
- [ ] A test of the web logger shows the same for a tRPC procedure error.
- [ ] The redaction policy (what is redacted, where, and why) is documented under Logging and ids in `docs`, and verified by the docs test.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 51 (TD-048) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
