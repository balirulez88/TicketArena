# 58: Harness test workspace hardening

**What to build:** the harness's own test infrastructure is proven where it actually runs and isolated in every suite: the disposable test workspace is measured on the sandbox volume, its signal cleanup is observed, the shell suites cannot reach the real repository through inherited Git variables, and the sandbox suite's checks assert outcomes rather than log wording. Resolves TD-087 to TD-095 in `docs/technical-debt.md`. These are findings of the review of branches `harness/test-workspace-isolation` and `fix/sandbox-lead-baseline-fixture`.

**Delivered early:** TD-091 is already `RESOLVED` (branch `fix/td-091-shell-suite-git-isolation`, 2026-11-13, rated HIGH by the maintainer): every `scripts/*.test.sh` sources `scripts/test-git-isolation.sh` first, which clears the variables `git rev-parse --local-env-vars` names. Its proof is `scripts/test-git-isolation.test.mjs`: a decoy repository receives a fixture's commit without the helper and none with it, and a wiring check that each suite sources it first. No suite is run end to end with an inherited `GIT_DIR`; that would take hours and Docker.

**Type:** test

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] TD-087: on Linux, where signals are delivered, a scenario in `scripts/ralph-test-workspace.test.mjs` sends `SIGTERM` and `SIGINT` to a child that imports the module and asserts the session was removed by the handler, not by a later run's recovery. Sabotage: deleting the handler turns it red.
- [ ] TD-088: a Docker scenario in `scripts/sandbox.test.sh` runs the harness suite in the `--tools` stage on the sandbox volume and fails if it exceeds a stated share of the 1800 s limit.
- [ ] TD-089: the guard test in `scripts/ralph-test-workspace.test.mjs` also fails for a test file that reads `TEMP`, `TMP` or `TMPDIR` directly or calls `mktemp`, and is not satisfied by the module's path in a comment. Sabotage: a planted file of each kind turns it red.
- [ ] TD-090: the Git discovery test runs with a repository above its fixture whatever `RALPH_TEST_TMP_ROOT` is. Sabotage: removing `GIT_CEILING_DIRECTORIES` turns it red.
- [x] TD-091: `scripts/ralph-loop.test.sh`, `scripts/ralph-sessions.test.sh`, `scripts/ralph-resume.test.sh`, `scripts/ralph-lead.test.sh` and `scripts/sandbox.test.sh` clear Git's repository-local variables at start. Sabotage: without the clearing, running a suite with `GIT_DIR` exported to a canary repository changes the canary.
- [ ] TD-092: the lead scenarios' checks in `scripts/sandbox.test.sh` assert recorded sessions and exit codes instead of log wording. Sabotage: rewording the matched log lines leaves the checks meaningful, and removing the session turns them red.
- [ ] TD-093: the `lead-interrupt` scenario asserts `lead-started` exists and stops only its own run's container. Sabotage: a second running container of the image is left untouched.
- [ ] TD-094: a root spelled with an 8.3 short name of the repository is refused, on a volume that has such names. Sabotage: resolving with `realpathSync` turns it red.
- [ ] TD-095: a root on a missing drive fails with an error naming `RALPH_TEST_TMP_ROOT`. Sabotage: removing the wrapping turns it red.
- [ ] Independent Standards and Spec reviews approve the change; the full quality gate and the real-Docker sandbox tests pass.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 58 is `RESOLVED`, with the tests that prove it named in `Verification`.
