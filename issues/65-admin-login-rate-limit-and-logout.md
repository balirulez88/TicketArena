# 65: Admin login rate limit and logout

**What to build:** the admin login can be exposed publicly. Password guessing is slowed by the same 1-per-10-seconds limiter the destructive admin actions already use, and an admin can log out. MVP scope: reuse the existing limiter, with no per-IP tracking and no server-side session store. Follows the answer recorded for ticket 35 in `.devflow/questions.md`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Every `POST /api/admin/login` takes the existing admin rate limit (action `login`) before the password is compared; a refused attempt compares no password, sets no cookie and answers with the retry time.
- [ ] If the limiter cannot be reached, the login is refused (fails closed), as the other admin actions are.
- [ ] `POST /api/admin/logout` clears the admin cookie and redirects with 303 to the login page; after it, admin procedures answer `UNAUTHORIZED` for that browser.

**Documentation deliverable (reviewed, not test-verified):** the admin docs state that a global limiter lets an attacker delay the real admin's login (accepted for the demo), and that logout clears the cookie but cannot revoke a copied one before its 8-hour expiry.
