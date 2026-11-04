#!/usr/bin/env bash
#
# Builds the sandbox image and runs ralph-loop.sh inside it. Arguments are forwarded to the
# loop, e.g. `./scripts/sandbox.sh --once` or `./scripts/sandbox.sh --ticket 03`.
# `./scripts/sandbox.sh --verify` only runs the quality gate on real services (no agent, no key).
# `./scripts/sandbox.sh --max-tickets N` runs a bounded batch: one sandbox run per ticket with
# GitHub CI verified in between (scripts/ralph-batch.mjs, which calls this script per ticket).
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${RALPH_IMAGE:-ticketarena-sandbox}"

for arg in "$@"; do
  [[ "${arg}" != --max-tickets ]] || exec node "${REPO_ROOT}/scripts/ralph-batch.mjs" "$@"
done
# A batch pushes into this repo ticket by ticket; a second, unrelated run must not interleave.
if [[ -d "${REPO_ROOT}/.ralph/batch/lock" && -z "${RALPH_BATCH_ID:-}" ]]; then
  echo "sandbox: a Ralph batch holds .ralph/batch/lock; wait for it (or remove the lock if no batch runs)" >&2
  exit 1
fi

command -v docker >/dev/null || {
  echo "sandbox: docker is required" >&2
  exit 1
}
if [[ "${1:-}" != "--verify" && -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "sandbox: export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN first" >&2
  exit 1
fi

docker build --tag "${IMAGE}" "${REPO_ROOT}"

# The container pushes green slices into this (non-bare) repo. `updateInstead` lets a push
# fast-forward the checked-out branch only when the working tree is clean, and refuses otherwise,
# so in-progress local edits can never be overwritten.
git -C "${REPO_ROOT}" config receive.denyCurrentBranch updateInstead

# The container is disposable, so its logs are written straight to the host as they happen and
# survive a rejected run or a crash. So does the resume state of a ticket paused by a provider
# failure (its work in progress is pushed as ralph/paused/<slug>).
mkdir -p "${REPO_ROOT}/.ralph/logs" "${REPO_ROOT}/.ralph/state"

tty_flag=()
[[ -t 0 && -t 1 ]] && tty_flag=(--tty --interactive)

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container-side paths.
MSYS_NO_PATHCONV=1 docker run --rm "${tty_flag[@]}" \
  --volume "${REPO_ROOT}:/host-repo" \
  --volume "${REPO_ROOT}/.ralph/logs:/ralph-logs" \
  --env RALPH_LOG_ROOT=/ralph-logs \
  --volume "${REPO_ROOT}/.ralph/state:/ralph-state" \
  --env RALPH_STATE_DIR=/ralph-state \
  --env RALPH_PROVIDER_RETRIES \
  --env RALPH_PROVIDER_BACKOFF \
  --env ANTHROPIC_API_KEY \
  --env CLAUDE_CODE_OAUTH_TOKEN \
  --env RALPH_AGENT_CMD \
  --env RALPH_MAX_ATTEMPTS \
  --env RALPH_BASE_BRANCH \
  --env RALPH_REVIEW_CMD \
  --env RALPH_MAX_REVIEW_ROUNDS \
  --env RALPH_REVIEW_BLOCKING \
  --env RALPH_REVIEW_TIMEOUT \
  --env RALPH_TEST_RUNNER \
  --env GIT_AUTHOR_NAME="$(git -C "${REPO_ROOT}" config user.name)" \
  --env GIT_AUTHOR_EMAIL="$(git -C "${REPO_ROOT}" config user.email)" \
  "${IMAGE}" "$@"
