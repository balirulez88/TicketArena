# Open questions

The agent assumed the answer below and continued. Edit `Answer:` to
override it; the next run reads this file.

## 2026-11-18 10:04 ticket 13

Which error does releaseHold give for a hold that is not HELD?

Assumed: HOLD_NOT_ACTIVE / tRPC CONFLICT, as placeOrder does

Answer: (open)

## 2026-11-18 10:04 ticket 13

Can a hold that expired but has not been swept yet be released?

Assumed: Yes: it is still HELD, so release succeeds

Answer: (open)

## 2026-11-18 10:04 ticket 13

What does the hold.released payload carry?

Assumed: { holdId, seatIds } with seatIds = seats actually freed (may be empty), hold's correlationId, causationId null

Answer: (open)

## 2026-11-18 10:05 ticket 14

AC8 asks to mark TD-013 RESOLVED in docs/technical-debt.md, but CLAUDE.md says that register is frozen and not updated by runs. Which wins?

Assumed: CLAUDE.md wins: the register is not edited; AC8 is satisfied by the AT-07 and lazy-expiry tests, named in the commit message, and a human updates TD-013 if wanted

Answer: (open)

## 2026-11-18 10:05 ticket 14

Ticket 13 lets an expired-but-unswept HELD hold be released; ticket 14 says a hold is valid iff T < holdExpiresAt everywhere. Should releaseHold change?

Assumed: No change in ticket 14: releaseHold stays as ticket 13 built it (the seats end AVAILABLE either way); revisit if the answer to ticket 13's question says otherwise

Answer: (open)
