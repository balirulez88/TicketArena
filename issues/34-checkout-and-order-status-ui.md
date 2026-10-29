# 34: Checkout and order status UI

**What to build:** a buyer with a hold checks out with an email and optional phone, then follows the order until it is confirmed, cancelled or expired. Spec: Frontend.

**Blocked by:** 33, 09

**Status:** ready-for-agent

- [ ] The checkout form is validated with zod; the `idempotencyKey` is generated once per checkout attempt and reused on retries.
- [ ] `HOLD_EXPIRED` and `IDEMPOTENCY_KEY_REUSED` are shown as clear messages.
- [ ] The order status page polls every 2s until a final state and shows the outcome, including refund information.
