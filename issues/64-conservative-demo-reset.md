# 64: Conservative demo reset

**What to build:** resetting the demo never destroys financial history. Today `admin.resetDemo` deletes the demo event's orders, order lines and ledger rows, so a delayed, duplicate or late payment can arrive for an order that no longer exists. The reset now frees the seats and clears the queue but keeps every order, its lines and its ledger rows, so the saga can still reconcile any payment that arrives later. It keeps refusing while a buyer is still owed an outcome. MVP scope: no archive tables, no schema change, no new workflow. Follows the answer recorded for ticket 37 in `.devflow/questions.md`.

**Blocked by:** 37

**Status:** ready-for-agent

- [ ] After a reset, every demo order, order line and ledger row that existed before is still there, unchanged; holds that have an order are kept; only holds without an order are deleted. `ResetResult` reports kept orders instead of deleted orders and ledger rows.
- [ ] After a reset, every demo seat is `AVAILABLE` with no hold and no buyer, so the per-buyer ticket limit counts nothing from before the reset and a new buyer can hold any seat.
- [ ] The reset still refuses with `RESET_BLOCKED` and changes nothing while a demo order is `PENDING_PAYMENT` or a demo refund obligation is open (`REFUND_REQUESTED` or `MANUAL_REVIEW`).
- [ ] A `payment.succeeded` delivered after a reset for a demo order that was `EXPIRED` before it finds the order and follows the saga's normal rule for that state; the seats it once held are not reclaimed.

**Documentation deliverable (reviewed, not test-verified):** the admin docs and the spec's demo reset section say what the reset keeps, what it frees, and when it refuses.
