# 52: Harness quarantine and ptrace-refusal regression coverage

**What to build:** rejected agent work can no longer be published or checked out by accident, and the verifier's refusal to run tests on a kernel without `ptrace` restrictions is proven by a test. Resolves TD-059 (LOW, SECURITY) and TD-060 (LOW, VERIFICATION) in `docs/technical-debt.md`. This changes the harness, so it is reviewed and merged outside Ralph (status `ready-for-human`): a sandboxed agent must not author its own trust boundary. No feature ticket depends on it.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] TD-059: the host imports a rejected run's work under `refs/ralph/rejected/<slug>-<run-id>`, outside `refs/heads/`; the batch detects rejections there; `ralph-loop.sh` outside the sandbox keeps `refs/heads/rejected/` (tests for the batch, the importer and a real Docker rejection).
- [ ] TD-060: the verifier's test stage reads the Yama `ptrace_scope` from a path fixed at image build; a Docker scenario whose test image provides scope 0 expects the stage to refuse to run, and fails if the refusal is removed.
- [ ] Independent Standards and Spec reviews by host-side reviewers approve the change; the full quality gate, the real-Docker sandbox tests and GitHub CI pass.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 52 (TD-059, TD-060) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
