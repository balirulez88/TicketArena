# 35: Admin authentication and live snapshot

**What to build:** an operator logs in with the admin password and sees a dashboard, refreshed every second, with seat, order, payment, queue and booking-metric figures. Spec: Admin dashboard; ADR 0012.

**Blocked by:** 10, 30, 08

**Status:** ready-for-agent

- [ ] `ADMIN_PASSWORD` is validated at the boundary; login sets a signed admin cookie; `adminProcedure` and `proxy.ts` guard `/admin`.
- [ ] `admin.snapshot` returns seats by status, orders by status, pending payments, queue length, active shoppers, and the metrics available so far.
- [ ] The dashboard polls every 1s.
- [ ] AT-44 (auth part): admin procedures reject a missing or invalid admin cookie.
