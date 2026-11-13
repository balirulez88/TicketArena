# Sourced first by every bash test suite (scripts/*.test.sh), before any fixture exists (TD-091).
# Git's repository-local variables outrank discovery and GIT_CEILING_DIRECTORIES. A hook running
# in a linked worktree exports an absolute GIT_DIR and GIT_INDEX_FILE, and a fixture's
# `git -C dir add/commit` would then write to the real repository and its index. The names come
# from the running Git, so the list matches its version; scripts/ralph-test-workspace.mjs clears
# Git 2.45's list for the Node suites. If Git cannot name them, the suite stops here (errexit).
# Git is asked in a clean environment: the list does not depend on it, and an inherited variable
# can make Git refuse to answer (Git 2.39, the sandbox image's, lists GIT_INTERNAL_SUPER_PREFIX,
# and any value there makes `rev-parse` exit 128).
git_local_variables="$(env -i PATH="${PATH}" git rev-parse --local-env-vars)"
# One name per line: the word splitting is the point.
# shellcheck disable=SC2086
unset ${git_local_variables}
unset git_local_variables
