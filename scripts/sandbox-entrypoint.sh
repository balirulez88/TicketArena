#!/usr/bin/env bash
#
# Container entrypoint. The container never sees the host repository (ADR 0014). Its only host
# mounts are:
#   /ralph-in   read-only: repo.bundle (the base branch and parked work) and state/ (resume state
#               the host vouches for)
#   /ralph-out  this run's output: logs/ as they happen, then state/ and result.bundle at exit
# Ralph pushes to a staging bare repository that only this container has. When the loop ends,
# its branches leave as a Git bundle, which is data: the host validates it
# (scripts/ralph-accept.mjs) and is the only one that changes the host repository.
#
# `--verify` starts the services and runs the quality gate once on RALPH_VERIFY_COMMIT (default:
# the bundle's main), without an agent or an API key. The host runs it on every candidate before
# accepting it, and it also serves as a self-test that the sandbox can judge slices on real
# infrastructure.
set -Eeuo pipefail

readonly IN=/ralph-in
readonly OUT=/ralph-out
readonly STAGING="${HOME}/staging.git"
readonly WORKSPACE="${HOME}/workspace"
readonly STATE="${HOME}/ralph-state"
readonly BASE_BRANCH="${RALPH_BASE_BRANCH:-main}"

verify_only=false
if [[ "${1:-}" == "--verify" ]]; then
  verify_only=true
  shift
fi

[[ -f "${IN}/repo.bundle" ]] || {
  echo "sandbox: mount the input directory (with repo.bundle) at ${IN}" >&2
  exit 1
}
if [[ "${verify_only}" == false && -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "sandbox: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 1
fi

git config --global user.name "${GIT_AUTHOR_NAME:-Ralph Loop}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-ralph@localhost}"

if [[ "${verify_only}" == true ]]; then
  git init --quiet --initial-branch="${BASE_BRANCH}" "${WORKSPACE}"
  cd "${WORKSPACE}"
  git fetch --quiet --no-tags "${IN}/repo.bundle" '+refs/*:refs/bundle/*'
  commit="${RALPH_VERIFY_COMMIT:-refs/bundle/heads/${BASE_BRANCH}}"
  git reset --quiet --hard "${commit}"
  log="$(git log -1 --format='%h %s')"
  echo "sandbox: verifying ${log}" >&2
  # The register check is protected and needs no dependencies, so it runs first, before
  # `pnpm install` or any test executes code the slice wrote and could rewrite it in this
  # checkout. Not through `pnpm run`, which installs first; the command comes from the root
  # package.json, which no run can change. `check` below runs it again.
  command="$(node -e 'process.stdout.write(require("./package.json").scripts?.["check:debt"] ?? "")')"
  [[ -z "${command}" ]] || bash -c "${command}"
  pnpm install --frozen-lockfile
  # shellcheck source=sandbox-services.sh
  source /usr/local/lib/sandbox-services.sh
  sandbox_start_services
  exec pnpm run check
fi

git clone --quiet --mirror "${IN}/repo.bundle" "${STAGING}"
git clone --quiet --branch "${BASE_BRANCH}" "${STAGING}" "${WORKSPACE}"
mkdir -p "${STATE}" "${OUT}/logs"
[[ ! -d "${IN}/state" ]] || cp -R "${IN}/state/." "${STATE}/"
cd "${WORKSPACE}"
pnpm install --frozen-lockfile

# shellcheck source=sandbox-services.sh
source /usr/local/lib/sandbox-services.sh
sandbox_start_services

# Every branch Ralph pushed goes out whatever the loop's outcome, because a rejection and a
# pause are results as well. The exit status is only a hint to the host: what the host accepts
# is decided by validating the bundle.
status=0
RALPH_PUSH_REMOTE=origin RALPH_LOG_ROOT="${OUT}/logs" RALPH_STATE_DIR="${STATE}" \
  ./ralph-loop.sh "$@" || status=$?
mkdir -p "${OUT}/state"
cp -R "${STATE}/." "${OUT}/state/"
git -C "${STAGING}" bundle create --quiet "${OUT}/result.bundle.tmp" --branches
mv "${OUT}/result.bundle.tmp" "${OUT}/result.bundle"
exit "${status}"
