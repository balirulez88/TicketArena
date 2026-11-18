# 32: Events and seat-map UI

**What to build:** a visitor can browse events, open one, and see its seat map with seat status and prices, fully usable by keyboard and screen reader. Spec: Frontend.

**Blocked by:** 03

**Status:** done

**Completed:** 2026-11-18 on devflow/run-202611181443 (run 202611181443)

- [x] Events list and event page (venue, date, prices per section, on-sale status) built with shadcn/ui.
- [x] Seat map as a CSS grid of native `<button>` elements with `aria-label` (section, row, number, price, status) and `aria-pressed`; keyboard navigable.
- [x] Seat selection (up to 6) lives in a Zustand store; server data comes via TanStack Query.
- [x] Component tests cover the selection rules and accessible names.
