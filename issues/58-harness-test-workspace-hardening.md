# 58: Harness test workspace hardening

**What to build:** the harness's own test infrastructure is proven where it actually runs and isolated in every suite: the disposable test workspace is exercised on Linux inside the sandbox image, its signal cleanup is observed, the shell suites cannot reach the real repository through inherited Git variables, and the sandbox suite's checks assert outcomes rather than log wording. Resolves TD-087 to TD-093 in `docs/technical-debt.md`. These are findings of the review of branches `harness/test-workspace-isolation` and `fix/sandbox-lead-baseline-fixture`.

**Type:** test

**Blocked by:** None (can start immediately)

**Status:** ready-for-human

- [ ] TD-087: on Linux, where `SIGTERM` is delivered, a scenario in `scripts/ralph-test-workspace.test.mjs` sends it to a child that imports the module and asserts the session was removed by the handler, not by a later run's recovery. Sabotage: deleting the handler turns it red.
- [ ] TD-088: a Docker scenario in `scripts/sandbox.test.sh` runs `scripts/ralph-test-workspace.test.mjs` inside the sandbox image, covering Linux process identification and the default root, and records the `--tools` stage's duration against its 1800 s limit.
- [ ] TD-089: the guard test in `scripts/ralph-test-workspace.test.mjs` also fails for a test file that reads `TEMP`, `TMP` or `TMPDIR` directly or calls `mktemp`, and is not satisfied by the module's path in a comment. Sabotage: a planted file of each kind turns it red.
- [ ] TD-090: the Git discovery test runs with a repository above its fixture whatever `RALPH_TEST_TMP_ROOT` is. Sabotage: removing `GIT_CEILING_DIRECTORIES` turns it red.
- [ ] TD-091: `scripts/ralph-loop.test.sh`, `scripts/ralph-sessions.test.sh`, `scripts/ralph-resume.test.sh`, `scripts/ralph-lead.test.sh` and `scripts/sandbox.test.sh` clear Git's repository-local variables at start. Sabotage: without the clearing, running a suite with `GIT_DIR` exported to a canary repository changes the canary.
- [ ] TD-092: the lead scenarios' checks in `scripts/sandbox.test.sh` assert recorded sessions and exit codes instead of log wording. Sabotage: rewording the matched log lines leaves the checks meaningful, and removing the session turns them red.
- [ ] TD-093: the `lead-interrupt` scenario asserts `lead-started` exists and stops only its own run's container. Sabotage: a second running container of the image is left untouched.
- [ ] Independent Standards and Spec reviews approve the change; the full quality gate and the real-Docker sandbox tests pass.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 58 is `RESOLVED`, with the tests that prove it named in `Verification`.
