#!/usr/bin/env bash
#
# Container entrypoint. Works on a fresh CLONE of the mounted host repo instead of the mount
# itself, which:
#   - keeps the agent away from the host working tree (only git pushes cross the boundary), and
#   - keeps Linux node_modules separate from the host's (e.g. Windows-native binaries).
set -Eeuo pipefail

readonly HOST_REPO=/host-repo
readonly WORKSPACE="${HOME}/workspace"
readonly BASE_BRANCH="${RALPH_BASE_BRANCH:-main}"

[[ -d "${HOST_REPO}/.git" ]] || {
  echo "sandbox: mount the repository at ${HOST_REPO}" >&2
  exit 1
}
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "sandbox: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 1
fi

# The bind mount is owned by the host user, which git treats as untrusted by default.
git config --global --add safe.directory "${HOST_REPO}"
git config --global user.name "${GIT_AUTHOR_NAME:-Ralph Loop}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-ralph@localhost}"

git clone --quiet --branch "${BASE_BRANCH}" "${HOST_REPO}" "${WORKSPACE}"
cd "${WORKSPACE}"
pnpm install --frozen-lockfile

RALPH_PUSH_REMOTE=origin exec ./ralph-loop.sh "$@"
