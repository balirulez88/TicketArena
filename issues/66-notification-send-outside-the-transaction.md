# 66: Notification send outside the transaction

**What to build:** a slow notification provider never holds a database transaction open. The notification handler still calls `provider.send` inside the runner transaction, the part of TD-051 that ticket 44 left open for payments only. The handler records the notification as pending in one transaction, sends outside it, and records the outcome in a second one; a redelivery after a crash between the two neither loses nor duplicates the notification. MVP scope: follow ticket 44's pattern for payments; no new framework.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] With a provider slower than an injected runner transaction timeout, the notification is still sent and recorded, and no transaction times out.
- [ ] A crash after the send but before the outcome is recorded is redelivered and leaves exactly one sent notification per channel (the provider is idempotent on the notification id).
- [ ] The existing notification tests (one confirmation per channel, the expiry email) stay green.

**Documentation deliverable (reviewed, not test-verified):** the messaging docs describe the pending, send and record steps and why the send is outside the transaction.
