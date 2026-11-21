# 20: Refund execution in the payment service

**What to build:** a refund obligation is carried out exactly once by the mock Payment service, and the booking ledger records the payment as refunded. Spec: Refund obligations, Mock Payment service.

**Blocked by:** 19

**Status:** done

**Completed:** 2026-11-21 on devflow/run-202611211043 (run 202611211043)

- [x] Payment consumes `payment.refund_requested`, inserts into `payment.refunds` (unique `paymentId`) and emits `payment.refunded` (with contact).
- [x] The booking saga handles `payment.refunded`: ledger `REFUND_REQUESTED` or `MANUAL_REVIEW` → `REFUNDED`; unknown `paymentId` → poison.
- [x] AT-23: duplicate `payment.refund_requested` → one refund row, one `payment.refunded`.
