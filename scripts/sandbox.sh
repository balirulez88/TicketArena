#!/usr/bin/env bash
#
# Builds the sandbox image and runs ralph-loop.sh inside it. Arguments are forwarded to the
# loop, e.g. `./scripts/sandbox.sh --once` or `./scripts/sandbox.sh --ticket 03`.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${RALPH_IMAGE:-ticketarena-sandbox}"

command -v docker >/dev/null || {
  echo "sandbox: docker is required" >&2
  exit 1
}
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "sandbox: export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN first" >&2
  exit 1
fi

docker build --tag "${IMAGE}" "${REPO_ROOT}"

# The container pushes green slices into this (non-bare) repo. `updateInstead` lets a push
# fast-forward the checked-out branch only when the working tree is clean, and refuses otherwise,
# so in-progress local edits can never be overwritten.
git -C "${REPO_ROOT}" config receive.denyCurrentBranch updateInstead

tty_flag=()
[[ -t 0 && -t 1 ]] && tty_flag=(--tty --interactive)

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container-side paths.
MSYS_NO_PATHCONV=1 docker run --rm "${tty_flag[@]}" \
  --volume "${REPO_ROOT}:/host-repo" \
  --env ANTHROPIC_API_KEY \
  --env CLAUDE_CODE_OAUTH_TOKEN \
  --env RALPH_MAX_ATTEMPTS \
  --env RALPH_BASE_BRANCH \
  --env GIT_AUTHOR_NAME="$(git -C "${REPO_ROOT}" config user.name)" \
  --env GIT_AUTHOR_EMAIL="$(git -C "${REPO_ROOT}" config user.email)" \
  "${IMAGE}" "$@"
